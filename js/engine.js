// The rules engine. Given a build (the player's picks) and a content pack, it works out
// every decision the player still has to make and the character those picks produce.
// It never mutates the build; the UI re-runs resolve() after every change.
import {
  ABILITY_KEYS, ABILITIES, SKILLS, STANDARD_ARRAY, POINT_BUY, STANDARD_LANGUAGES,
  mod, profBonus, spellSlots, pactSlots, maxSpellLevel,
} from "./rules.js";

export const titleCase = s => String(s ?? "").replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());

export function emptyBuild() {
  return {
    level: 1,
    class: null,
    subclass: null,
    background: null,
    species: null,
    abilities: { method: "standard", scores: {} },
    choices: {},      // decision key -> array of values (or an object for ability increases)
    equipment: {},    // "class" | "background" -> option label
    languages: [],
    overrides: false, // DM override acknowledged on the review step
  };
}

// ---------- resolve ----------
// Two passes: the first finds the ability increases, the second evaluates formulas
// (resource maximums, bonuses) against the final ability scores.
export function resolve(build, pack) {
  const first = resolvePass(build, pack, null);
  return resolvePass(build, pack, finalScores(build, first));
}

function resolvePass(build, pack, scores) {
  const out = {
    decisions: { class: [], background: [], species: [], abilities: [], spells: [], details: [] },
    features: [], proficiencies: { skill: [], save: [], armor: [], weapon: [], tool: [], language: [] },
    expertise: [], stats: {}, resources: {}, spells: [], feats: [], warnings: [], missing: new Set(),
    asi: [], sources: { classes: new Set(), subclasses: new Set(), species: new Set(), backgrounds: new Set(), feats: new Set(), spells: new Set() },
  };
  const level = Math.min(20, Math.max(1, build.level || 1));
  const ctx = { build, pack, out, level, scores: scores ?? Object.fromEntries(ABILITY_KEYS.map(a => [a, baseScores(build)[a] ?? 10])) };

  // Species first (2024 order is class, background, species, but nothing depends on order here).
  const species = build.species && pack.species?.[build.species];
  if (species) {
    out.sources.species.add(species.id ?? build.species);
    const scope = newScope({ path: `species.${build.species}`, step: "species", label: species.name, levelWord: "character" });
    out.stats.speed = species.speed;
    out.stats.creature_type = species.creature_type;
    const sizes = [].concat(species.size ?? []);
    if (sizes.length > 1) {
      walk(ctx, [{ type: "choice", id: "size", label: "Size", choose: 1, from: sizes, each: { type: "stat", stat: "size" } }], scope, out.decisions.species);
    } else out.stats.size = sizes[0];
    walk(ctx, species.grants, scope, out.decisions.species);
  }

  const bg = build.background && pack.backgrounds?.[build.background];
  if (bg) {
    out.sources.backgrounds.add(build.background);
    const scope = newScope({ path: `background.${build.background}`, step: "background", label: bg.name, levelWord: "character" });
    walk(ctx, bg.grants, scope, out.decisions.background);
  }

  const cls = build.class && pack.classes?.[build.class];
  if (cls) walkClass(ctx, cls, level);

  // Core rule: Common plus two standard languages.
  out.proficiencies.language.push({ value: "Common", source: "Every character" });
  const langKey = "core/languages";
  const langs = asArray(build.choices[langKey]);
  out.decisions.details.push(makeDecision({
    key: langKey, kind: "choice", step: "details", source: "Every character", label: "Languages",
    choose: 2, value: langs, options: STANDARD_LANGUAGES.map(l => ({ value: l, label: l })),
    note: "You know Common plus two languages of your choice.",
  }));
  for (const l of langs) out.proficiencies.language.push({ value: l, source: "Languages" });

  computeWarnings(ctx);
  return out;
}

function newScope({ path, step, label, levelWord, params = {}, classLevel = null }) {
  return { path, step, label, levelWord, params, classLevel, choices: new Map() };
}

const asArray = v => (Array.isArray(v) ? v : v == null ? [] : [v]);

function resolveRef(v, scope) {
  if (typeof v !== "string" || !v.startsWith("$")) return v;
  const [kind, name] = v.slice(1).split(".");
  if (kind === "param") return scope.params?.[name];
  if (kind === "choice") {
    const val = scope.choices.get(name);
    return Array.isArray(val) && val.length === 1 ? val[0] : val;
  }
  return undefined;
}

function walkClass(ctx, cls, level) {
  const { build, pack, out } = ctx;
  out.sources.classes.add(build.class);
  const scope = newScope({ path: `class.${build.class}`, step: "class", label: cls.name, levelWord: "class", classLevel: level });
  scope.castAbility = cls.spellcasting?.ability;
  const p = cls.proficiencies ?? {};
  for (const s of p.saves ?? []) out.proficiencies.save.push({ value: s, source: cls.name });
  for (const a of p.armor ?? []) out.proficiencies.armor.push({ value: a, source: cls.name });
  for (const w of p.weapons ?? []) out.proficiencies.weapon.push({ value: w, source: cls.name });
  for (const t of p.tools ?? []) out.proficiencies.tool.push({ value: t, source: cls.name });
  if (p.skills) {
    walk(ctx, [{ type: "choice", id: "skills", label: `${cls.name} skills`, choose: p.skills.choose, from: p.skills.from, each: { type: "proficiency", kind: "skill" } }],
      scope, out.decisions.class);
  }

  for (let l = 1; l <= level; l++) {
    const grants = cls.levels?.[l] ?? [];
    walk(ctx, grants, { ...scope, at: l }, out.decisions.class, l);
  }

  // Subclass
  const subLevel = cls.subclass_level ?? 3;
  if (level >= subLevel) {
    const subs = Object.entries(pack.subclasses ?? {}).filter(([, s]) => s.class === build.class);
    const key = `class.${build.class}/subclass`;
    const chosen = build.subclass && pack.subclasses?.[build.subclass]?.class === build.class ? build.subclass : null;
    out.decisions.class.push(makeDecision({
      key, kind: "subclass", step: "class", source: cls.name, level: subLevel, label: `${cls.name} subclass`, choose: 1,
      value: chosen ? [chosen] : [],
      options: subs.map(([id, s]) => ({ value: id, label: s.name, text: s.text, link: `#/subclasses/${id}` })),
    }));
    if (chosen) {
      const sub = pack.subclasses[chosen];
      out.sources.subclasses.add(chosen);
      const subScope = newScope({ path: `subclass.${chosen}`, step: "class", label: sub.name, levelWord: "class", classLevel: level });
      subScope.castAbility = cls.spellcasting?.ability;
      const parent = out.decisions.class.at(-1).children;
      for (let l = 1; l <= level; l++) walk(ctx, sub.levels?.[l] ?? [], subScope, parent, l);
    }
  }

  // Class spells the player picks: cantrips and prepared spells from the class table.
  const sc = cls.spellcasting;
  if (sc && sc.progression !== "none") {
    const t = cls.table ?? {};
    const cantrips = t.cantrips?.[level - 1] ?? 0;
    const prepared = t.prepared?.[level - 1] ?? 0;
    const maxLvl = maxSpellLevel(sc.progression, level);
    const castWith = { type: "spells", cast_ability: sc.ability, class_spell: true };
    if (cantrips) walk(ctx, [{ type: "choice", id: "class_cantrips", label: "Cantrips", choose: cantrips, from: { pool: "spells", lists: sc.list, level: 0, exclude_known: true }, each: castWith }],
      { ...scope, step: "spells" }, out.decisions.spells);
    if (prepared && maxLvl) walk(ctx, [{ type: "choice", id: "class_prepared", label: "Prepared spells", choose: prepared, swap: "long_rest",
      from: { pool: "spells", lists: sc.list, min_level: 1, max_level: maxLvl, exclude_known: true }, each: castWith }],
      { ...scope, step: "spells" }, out.decisions.spells);
  }
}

// Walk a list of grants. `into` collects decisions; nested decisions go into a parent's children.
function walk(ctx, grants, scope, into, classLevel = null) {
  for (const g of grants ?? []) {
    if (!g || typeof g !== "object") continue;
    if (g.at_level && g.at_level > ctx.level) continue;
    apply(ctx, g, scope, into, classLevel);
  }
}

function sourceLabel(scope, classLevel) {
  return classLevel ? `${scope.label}, level ${classLevel}` : scope.label;
}

function apply(ctx, g, scope, into, classLevel) {
  const { out } = ctx;
  const source = sourceLabel(scope, classLevel);
  switch (g.type) {
    case "feature": {
      const variant = g.by_choice ? asArray(scope.choices.get(g.by_choice))[0] : null;
      out.features.push({
        name: g.name, text: variant && g.variants ? g.variants[variant] : g.text, source,
        action: g.action, uses: g.uses ? { ...g.uses, max: evalFormula(g.uses.max, ctx, scope) } : null,
        dice: g.dice, bonus: g.bonus, key: `${scope.path}/${g.name}`,
      });
      if (g.bonus?.checks) (out.bonuses ??= []).push({ checks: g.bonus.checks, value: evalFormula(g.bonus.value, ctx, scope), source: g.name });
      break;
    }
    case "proficiency":
      for (const v of g.values ?? []) out.proficiencies[g.kind]?.push({ value: v, source });
      break;
    case "expertise":
      for (const v of g.values ?? []) out.expertise.push({ value: v, source });
      break;
    case "stat": {
      const v = resolveRef(g.value, scope);
      const cur = out.stats[g.stat];
      if (g.mode === "max") out.stats[g.stat] = Math.max(cur ?? 0, v);
      else if (g.mode === "add") out.stats[g.stat] = (cur ?? 0) + v;
      else out.stats[g.stat] = v;
      break;
    }
    case "resource":
      out.resources[g.id] = { ...out.resources[g.id], ...g, max: evalFormula(g.max, ctx, scope), source };
      break;
    case "spells":
      for (const id of g.ids ?? []) addSpell(ctx, id, g, scope, source);
      break;
    case "asi":
      applyAsi(ctx, g, scope, into, source);
      break;
    case "feat":
      applyFeat(ctx, g.id, Object.fromEntries(Object.entries(g.params ?? {}).map(([k, v]) => [k, resolveRef(v, scope)])), scope, into, source);
      break;
    case "subclass":
      break; // handled in walkClass so subclass features can nest under the pick
    case "choice":
      applyChoice(ctx, g, scope, into, classLevel, source);
      break;
  }
}

function addSpell(ctx, id, g, scope, source) {
  const { out, pack } = ctx;
  const entry = pack.spells?.[id];
  if (!entry) out.missing.add(`spells:${id}`);
  else out.sources.spells.add(id);
  const ability = resolveRef(g.cast_ability, scope) || scope.castAbility || null;
  out.spells.push({
    id, name: entry?.name ?? titleCase(id), level: entry?.level ?? null, source,
    always_prepared: !!g.always_prepared, free_cast: g.free_cast ?? null,
    cast_ability: ability || null, class_spell: !!g.class_spell,
  });
}

function applyAsi(ctx, g, scope, into, source) {
  const key = `${scope.path}/asi`;
  const value = ctx.build.choices[key] ?? null;
  const d = makeDecision({
    key, kind: "asi", step: scope.step === "background" ? "abilities" : scope.step, source,
    label: g.mode === "background" ? `${scope.label} ability scores` : "Ability score increase",
    asi: { mode: g.mode, abilities: g.abilities, points: g.points, max_per_ability: g.max_per_ability, cap: g.cap ?? 20 },
    value,
  });
  d.complete = asiComplete(d.asi, value);
  ctx.out.asi.push(d);
  // Background increases are made on the ability scores step, everything else inline.
  if (g.mode === "background") ctx.out.decisions.abilities.push(d);
  else into.push(d);
}

export function asiIncrements(asi, value) {
  const inc = {};
  if (!value) return inc;
  if (asi.mode === "background") {
    if (value.mode === "2/1") { if (value.plus2) inc[value.plus2] = 2; if (value.plus1) inc[value.plus1] = (inc[value.plus1] ?? 0) + 1; }
    if (value.mode === "1/1/1") for (const a of asi.abilities ?? []) inc[a] = 1;
  } else {
    for (const a of ABILITY_KEYS) if (value[a]) inc[a] = value[a];
  }
  return inc;
}

function asiComplete(asi, value) {
  if (!value) return false;
  if (asi.mode === "background") {
    if (value.mode === "1/1/1") return true;
    return value.mode === "2/1" && !!value.plus2 && !!value.plus1 && value.plus2 !== value.plus1;
  }
  const spent = ABILITY_KEYS.reduce((n, a) => n + (value[a] ?? 0), 0);
  return spent === asi.points;
}

function applyFeat(ctx, id, params, scope, into, source) {
  const { out, pack } = ctx;
  const feat = pack.feats?.[id];
  if (!feat) { out.missing.add(`feats:${id}`); return; }
  out.sources.feats.add(id);
  const featScope = newScope({ path: `${scope.path}>feat.${id}`, step: scope.step, label: feat.name, levelWord: "character", params });
  out.feats.push({ id, name: feat.name, source, params, prereq: feat.prereq, key: featScope.path });
  walk(ctx, feat.grants, featScope, into);
}

function queryOptions(ctx, q, scope) {
  const { pack, out } = ctx;
  const val = k => resolveRef(q[k], scope);
  if (q.pool === "spells") {
    const lists = asArray(val("lists")).filter(Boolean);
    if (q.lists && !lists.length) return { options: [], waiting: "Choose a spell list first." };
    const alwaysHave = new Set(out.spells.filter(s => s.always_prepared || s.level === 0).map(s => s.id));
    const have = new Set(out.spells.map(s => s.id));
    return {
      options: Object.entries(pack.spells ?? {})
        .filter(([, s]) => !lists.length || asArray(s.lists).some(l => lists.includes(l)))
        .filter(([, s]) => q.level == null || s.level === q.level)
        .filter(([, s]) => q.min_level == null || s.level >= q.min_level)
        .filter(([, s]) => q.max_level == null || s.level <= q.max_level)
        .filter(([id]) => !(q.exclude_known && alwaysHave.has(id)))
        .sort(([, a], [, b]) => (a.level - b.level) || a.name.localeCompare(b.name))
        .map(([id, s]) => ({ value: id, label: s.name, sub: s.level === 0 ? `${s.school ?? ""} cantrip` : `Level ${s.level} ${String(s.school ?? "").toLowerCase()}`, link: `#/spells/${id}`, level: s.level, note: have.has(id) ? "You already know this spell" : null })),
    };
  }
  if (q.pool === "feats") {
    const taken = new Set(out.feats.map(f => f.id));
    return {
      options: Object.entries(pack.feats ?? {})
        .filter(([, f]) => !q.category || f.category === q.category)
        .sort(([, a], [, b]) => a.name.localeCompare(b.name))
        .map(([id, f]) => ({
          value: id, label: f.name, text: f.text, link: `#/feats/${id}`,
          note: taken.has(id) && !f.repeatable ? "You already have this feat" : prereqProblem(ctx, f.prereq),
        })),
    };
  }
  const bucket = { species: "species", backgrounds: "backgrounds", classes: "classes" }[q.pool];
  return { options: Object.entries(pack[bucket] ?? {}).map(([id, e]) => ({ value: id, label: e.name })) };
}

function prereqProblem(ctx, prereq) {
  if (!prereq) return null;
  if (prereq.level && ctx.level < prereq.level) return `Requires level ${prereq.level}`;
  if (prereq.ability) {
    const scores = baseScores(ctx.build);
    const ok = Object.entries(prereq.ability).some(([a, v]) => (scores[a] ?? 0) >= v);
    if (!ok) return `Requires ${Object.entries(prereq.ability).map(([a, v]) => `${ABILITIES[a]} ${v}`).join(" or ")}`;
  }
  return null;
}

function applyChoice(ctx, g, scope, into, classLevel, source) {
  const { build } = ctx;
  const key = `${scope.path}/${g.id}`;
  let options = [], waiting = null;
  if (Array.isArray(g.from)) options = g.from.map(v => ({ value: v, label: prettyValue(v) }));
  else if (g.from) ({ options, waiting } = queryOptions(ctx, g.from, scope));
  else if (g.options) options = g.options.map(o => ({ value: o.id, label: o.name, text: o.text }));

  let value = asArray(build.choices[key]).filter(v => options.some(o => o.value === v));
  let fixed = false;
  const forced = g.fixed_by ? resolveRef(g.fixed_by, scope) : undefined;
  if (forced != null) { value = [forced]; fixed = true; }
  if (!value.length && g.default != null) value = [g.default];

  const d = makeDecision({
    key, kind: "choice", step: scope.step, source, level: classLevel, label: g.label ?? titleCase(g.id),
    choose: g.choose ?? 1, value, options, fixed, waiting, swap: g.swap, isNamed: !!g.options, isSpell: g.from?.pool === "spells",
    isFeat: g.from?.pool === "feats",
  });
  into.push(d);
  scope.choices.set(g.id, value);

  if (g.options) {
    for (const v of value) {
      const opt = g.options.find(o => o.id === v);
      if (opt) walk(ctx, opt.grants, scope, d.children, classLevel);
    }
  }
  if (g.each) for (const v of value) applyEach(ctx, g.each, v, scope, d.children, source, key);
}

function applyEach(ctx, each, value, scope, into, source, choiceKey) {
  const { out } = ctx;
  switch (each.type) {
    case "spells": addSpell(ctx, value, each, scope, source); break;
    case "proficiency": out.proficiencies[each.kind]?.push({ value, source }); break;
    case "expertise": out.expertise.push({ value, source }); break;
    case "feat": applyFeat(ctx, value, Object.fromEntries(Object.entries(each.params ?? {}).map(([k, v]) => [k, resolveRef(v, scope)])), { ...scope, path: choiceKey }, into, source); break;
    case "stat": out.stats[each.stat] = value; break;
    default: break;
  }
}

function makeDecision(d) {
  const value = d.value;
  const complete = d.kind === "asi" ? false
    : d.fixed ? true
    : Array.isArray(value) && value.length === (d.choose ?? 1);
  return { children: [], complete, ...d };
}

const prettyValue = v => (v in ABILITIES ? ABILITIES[v] : titleCase(v));

// ---------- formulas ----------
function evalFormula(f, ctx, scope) {
  if (typeof f === "number") return f;
  if (typeof f !== "string") return null;
  const cls = ctx.build.class && ctx.pack.classes?.[ctx.build.class];
  const scores = ctx.scores;
  const lvl = scope.classLevel ?? ctx.level;
  const vars = {
    level: ctx.level, class_level: lvl, prof: profBonus(ctx.level),
    ...Object.fromEntries(ABILITY_KEYS.flatMap(a => [[a, scores[a] ?? 10], [`${a}_mod`, mod(scores[a] ?? 10)]])),
    spell_mod: cls?.spellcasting ? mod(scores[cls.spellcasting.ability] ?? 10) : 0,
  };
  const expr = f.replace(/table\.(\w+)/g, (_, c) => String(cls?.table?.[c]?.[lvl - 1] ?? 0))
    .replace(/[A-Za-z_]\w*/g, t => t in vars ? String(vars[t]) : (["min", "max", "floor", "ceil"].includes(t) ? `Math.${t}` : "0"));
  try { return Function(`"use strict"; return (${expr});`)(); } catch { return null; }
}

// ---------- ability scores ----------
export function baseScores(build) {
  const s = build.abilities?.scores ?? {};
  return Object.fromEntries(ABILITY_KEYS.map(a => [a, Number.isFinite(s[a]) ? s[a] : null]));
}

export function abilityProblems(build) {
  const { method } = build.abilities ?? {};
  const s = baseScores(build);
  const vals = ABILITY_KEYS.map(a => s[a]);
  if (vals.some(v => v == null)) return ["Assign all six ability scores."];
  if (method === "standard") {
    const sorted = [...vals].sort((a, b) => b - a).join();
    if (sorted !== [...STANDARD_ARRAY].join()) return ["Use each standard array value (15, 14, 13, 12, 10, 8) exactly once."];
  }
  if (method === "pointbuy") {
    if (vals.some(v => v < 8 || v > 15)) return ["Point buy scores must be between 8 and 15."];
    const spent = vals.reduce((n, v) => n + POINT_BUY.cost[v], 0);
    if (spent > POINT_BUY.budget) return [`Point buy is over budget: ${spent} of ${POINT_BUY.budget} points.`];
  }
  if (method === "manual" && vals.some(v => v < 3 || v > 18)) return ["Rolled scores are normally between 3 and 18."];
  return [];
}

// ---------- warnings ----------
function flatten(decisions) {
  return decisions.flatMap(d => [d, ...flatten(d.children ?? [])]);
}
export function allDecisions(res) {
  return Object.values(res.decisions).flatMap(flatten);
}

function computeWarnings(ctx) {
  const { build, pack, out } = ctx;
  const w = out.warnings;
  if (!build.class) w.push({ step: "class", text: "Choose a class." });
  if (!build.background) w.push({ step: "background", text: "Choose a background." });
  if (!build.species) w.push({ step: "species", text: "Choose a species." });

  for (const d of allDecisions(out)) {
    if (d.complete) continue;
    if (d.kind === "asi") w.push({ step: d.step, text: `${d.label}: not assigned yet.` });
    else if (d.waiting) w.push({ step: d.step, text: `${d.label}: ${d.waiting}` });
    else if (d.options.length < d.choose) w.push({ step: d.step, text: `${d.label}: this pack only has ${d.options.length} option${d.options.length === 1 ? "" : "s"}, but you need ${d.choose}.` });
    else w.push({ step: d.step, text: `${d.label}: ${d.value.length} of ${d.choose} chosen.` });
  }

  for (const p of abilityProblems(build)) w.push({ step: "abilities", text: p });

  // Duplicate skill proficiencies (2024 rules: pick a different one instead).
  const seen = new Map();
  for (const s of out.proficiencies.skill) {
    if (seen.has(s.value)) w.push({ step: "class", text: `You get ${s.value} from both ${seen.get(s.value)} and ${s.source}. Pick a different skill for one of them.` });
    else seen.set(s.value, s.source);
  }
  const langs = asArray(build.choices["core/languages"]);
  if (new Set(langs).size !== langs.length) w.push({ step: "details", text: "You picked the same language twice." });

  for (const f of out.feats) {
    const problem = prereqProblem(ctx, f.prereq);
    if (problem) w.push({ step: "class", text: `${f.name}: ${problem.toLowerCase()}.` });
  }
  const scores = finalScores(build, out);
  for (const a of ABILITY_KEYS) if (scores[a] > 20) w.push({ step: "abilities", text: `${ABILITIES[a]} is ${scores[a]}, above the usual maximum of 20.` });

  for (const m of out.missing) {
    const [kind, id] = m.split(":");
    w.push({ step: "review", text: `${titleCase(kind.replace(/s$/, ""))} "${titleCase(id)}" isn't in this content pack yet, so it won't show details.`, info: true });
  }
  if (build.class && !pack.classes?.[build.class]) w.push({ step: "class", text: "Your class isn't in this content pack anymore." });
}

export function finalScores(build, res) {
  const base = baseScores(build);
  const out = Object.fromEntries(ABILITY_KEYS.map(a => [a, base[a] ?? 10]));
  for (const d of res.asi) {
    if (!d.value) continue;
    for (const [a, n] of Object.entries(asiIncrements(d.asi, d.value))) out[a] = Math.min(out[a] + n, Math.max(d.asi.cap ?? 20, out[a]));
  }
  return out;
}

// ---------- the computed character ----------
export function summarize(build, pack, res = resolve(build, pack)) {
  const level = build.level || 1;
  const cls = pack.classes?.[build.class];
  const scores = finalScores(build, res);
  const mods = Object.fromEntries(ABILITY_KEYS.map(a => [a, mod(scores[a])]));
  const pb = profBonus(level);
  const skillProf = new Set(res.proficiencies.skill.map(s => s.value));
  const expert = new Set(res.expertise.map(e => e.value));
  const bonusFor = name => (res.bonuses ?? []).filter(b => b.checks.includes(name)).reduce((n, b) => n + (b.value ?? 0), 0);

  const skills = Object.entries(SKILLS).map(([name, ab]) => {
    const prof = skillProf.has(name), exp = expert.has(name);
    const bonus = mods[ab] + (exp ? pb * 2 : prof ? pb : 0) + bonusFor(name);
    return { name, ability: ab, prof, expertise: exp, bonus };
  });
  const saveProf = new Set(res.proficiencies.save.map(s => s.value));
  const saves = ABILITY_KEYS.map(a => ({ ability: a, prof: saveProf.has(a), bonus: mods[a] + (saveProf.has(a) ? pb : 0) }));

  const hd = cls?.hit_die ?? 8;
  const perLevel = Math.max(1, Math.floor(hd / 2) + 1 + mods.con);
  const hp = cls ? Math.max(1, hd + mods.con) + perLevel * (level - 1) : null;

  const sc = cls?.spellcasting;
  const spellcasting = sc && sc.progression !== "none" ? {
    ability: sc.ability, dc: 8 + pb + mods[sc.ability], attack: pb + mods[sc.ability],
    slots: sc.progression === "pact" ? null : spellSlots(sc.progression, level),
    pact: sc.progression === "pact" ? pactSlots(level) : null,
  } : null;

  const resources = Object.values(res.resources).map(r => ({
    id: r.id, name: r.name, recharge: r.recharge, short_rest_regain: r.short_rest_regain ?? null, source: r.source,
    max: r.max,
  }));

  const gold = ["class", "background"].reduce((n, k) => {
    const entry = k === "class" ? cls : pack.backgrounds?.[build.background];
    const opt = (entry?.starting_equipment ?? []).find(o => o.label === build.equipment?.[k]);
    return n + (opt?.gold ?? 0);
  }, 0);

  const spells = res.spells.map(s => ({
    ...s,
    dc: s.cast_ability ? 8 + pb + mods[s.cast_ability] : null,
    attack: s.cast_ability ? pb + mods[s.cast_ability] : null,
  }));

  return {
    level, scores, mods, pb, skills, saves, hp, hitDie: hd,
    ac: 10 + mods.dex, initiative: mods.dex,
    speed: res.stats.speed ?? 30, darkvision: res.stats.darkvision ?? 0, size: res.stats.size, creatureType: res.stats.creature_type,
    passivePerception: 10 + skills.find(s => s.name === "Perception").bonus,
    proficiencies: res.proficiencies, features: res.features, feats: res.feats, resources, spells, spellcasting, gold,
  };
}

