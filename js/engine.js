// The rules engine. Given a build (the player's picks) and a content pack, it works out
// every decision the player still has to make and the character those picks produce.
// It never mutates the build; the UI re-runs resolve() after every change.
import {
  ABILITY_KEYS, ABILITIES, SKILLS, STANDARD_ARRAY, POINT_BUY, STANDARD_LANGUAGES,
  mod, profBonus, pactSlots, maxSpellLevel, multiclassSlots,
} from "./rules.js";

// Capitalize each word ("alchemist's supplies" -> "Alchemist's Supplies", not "Alchemist'S").
export const titleCase = s => String(s ?? "").replace(/[_-]+/g, " ").replace(/(^|[\s(\/])(\w)/g, (_, pre, c) => pre + c.toUpperCase());

export function emptyBuild() {
  return {
    level: 1,         // total character level; always the sum of classes[].level once a class is picked
    classes: [],      // [{ id, level, subclass }]; the first entry is the starting class
    background: null,
    species: null,
    abilities: { method: "standard", scores: {} },
    choices: {},      // decision key -> array of values (or an object for ability increases)
    equipment: {},    // "class" | "background" -> option label
    languages: [],
    overrides: false, // DM override acknowledged on the review step
  };
}

// The character's own snapshot fills in anything the loaded pack no longer has (homebrew, renamed notes).
export function mergeContent(contentPack, snapshot = {}) {
  const out = { ...contentPack };
  for (const bucket of new Set([...Object.keys(snapshot), ...Object.keys(contentPack)])) {
    if (bucket === "meta") continue;
    out[bucket] = { ...(snapshot[bucket] ?? {}), ...(contentPack[bucket] ?? {}) };
  }
  return out;
}

// The content a character file keeps: every entry its build uses.
export function snapshotFor(res, pack) {
  const snapshot = {};
  for (const [bucket, ids] of Object.entries(res.sources)) {
    snapshot[bucket] = Object.fromEntries([...ids].filter(id => pack[bucket]?.[id]).map(id => [id, pack[bucket][id]]));
  }
  return snapshot;
}

// ---------- classes ----------
// Builds made before multiclassing stored one `class`/`subclass` plus `level`. This turns either
// shape into the current one without touching the original object.
export function normalizeBuild(build) {
  const b = { ...emptyBuild(), ...build };
  if (!Array.isArray(build.classes)) {
    b.classes = build.class ? [{ id: build.class, level: clampLevel(build.level), subclass: build.subclass ?? null }] : [];
  } else {
    b.classes = b.classes.filter(c => c?.id).map(c => ({ id: c.id, level: clampLevel(c.level), subclass: c.subclass ?? null }));
  }
  delete b.class;
  delete b.subclass;
  b.level = b.classes.length ? b.classes.reduce((n, c) => n + c.level, 0) : clampLevel(b.level);
  return b;
}

const clampLevel = n => Math.min(20, Math.max(1, Math.floor(Number(n) || 1)));

export const startingClass = build => normalizeBuild(build).classes[0] ?? null;

// Pick the starting class. Its level absorbs whatever the other classes don't use.
export function setStartingClass(build, id) {
  const b = normalizeBuild(build);
  const others = b.classes.slice(1).filter(c => c.id !== id);
  const used = others.reduce((n, c) => n + c.level, 0);
  b.classes = [{ id, level: Math.max(1, b.level - used), subclass: b.classes[0]?.id === id ? b.classes[0].subclass : null }, ...others];
  return normalizeBuild(b);
}

// Change the total level. The starting class takes up the difference.
export function setTotalLevel(build, total) {
  const b = normalizeBuild(build);
  total = clampLevel(total);
  if (!b.classes.length) return { ...b, level: total };
  const used = b.classes.slice(1).reduce((n, c) => n + c.level, 0);
  b.classes[0].level = Math.max(1, total - used);
  return normalizeBuild(b);
}

export function setSubclass(build, classId, subclassId) {
  const b = normalizeBuild(build);
  const c = b.classes.find(x => x.id === classId);
  if (c) c.subclass = subclassId;
  return b;
}

// Creation wizard: add a class at level 1, taking that level from the starting class.
export function addClass(build, id) {
  const b = normalizeBuild(build);
  if (!b.classes.length || b.classes[0].level < 2 || b.classes.some(c => c.id === id)) return b;
  b.classes[0].level -= 1;
  b.classes.push({ id, level: 1, subclass: null });
  return normalizeBuild(b);
}

// Remove an added class; its levels go back to the starting class.
export function removeClass(build, index) {
  const b = normalizeBuild(build);
  if (index < 1 || index >= b.classes.length) return b;
  const [gone] = b.classes.splice(index, 1);
  b.classes[0].level += gone.level;
  return normalizeBuild(b);
}

// Swap which class an added slot is, keeping its levels. Choices made for the old class stay in
// build.choices under its own keys, harmlessly, in case the player switches back.
export function changeClass(build, index, id) {
  const b = normalizeBuild(build);
  if (index < 1 || index >= b.classes.length || b.classes.some(c => c.id === id)) return b;
  b.classes[index] = { id, level: b.classes[index].level, subclass: null };
  return normalizeBuild(b);
}

// Set an added class's level without changing the total: the starting class gives or takes the difference.
export function setClassLevel(build, index, level) {
  const b = normalizeBuild(build);
  if (index < 1 || index >= b.classes.length) return b;
  const room = b.classes[0].level + b.classes[index].level - 1; // starting class keeps at least 1
  const next = Math.min(room, clampLevel(level));
  b.classes[0].level += b.classes[index].level - next;
  b.classes[index].level = next;
  return normalizeBuild(b);
}

// Level Up: one more level in a class the character has, or level 1 in a new one.
export function levelUp(build, id) {
  const b = normalizeBuild(build);
  const c = b.classes.find(x => x.id === id);
  if (c) c.level += 1;
  else b.classes.push({ id, level: 1, subclass: null });
  return normalizeBuild(b);
}

// What stops this build from taking (or keeping) `id` alongside its other classes, or null.
// Taking a new class needs the prerequisite of the new class AND of every current class.
export function multiclassBlockers(build, pack, id, scores) {
  const b = normalizeBuild(build);
  const ids = [...new Set([...b.classes.map(c => c.id), id])];
  if (ids.length < 2) return [];
  return ids.map(cid => {
    const cls = pack.classes?.[cid];
    const problem = cls && multiclassProblem(cls, scores);
    return problem ? `${cls.name} needs ${problem}` : null;
  }).filter(Boolean);
}

// Multiclassing prerequisites: `ability` passes if ANY listed score is high enough,
// `ability_all` only if EVERY listed score is.
function multiclassProblem(cls, scores) {
  const p = cls?.multiclass?.prereq;
  if (!p) return null;
  const short = Object.entries(p.ability_all ?? {}).filter(([a, v]) => (scores[a] ?? 0) < v);
  const any = Object.entries(p.ability ?? {});
  const anyOk = !any.length || any.some(([a, v]) => (scores[a] ?? 0) >= v);
  if (!short.length && anyOk) return null;
  const parts = [];
  if (short.length) parts.push(short.map(([a, v]) => `${ABILITIES[a]} ${v}`).join(" and "));
  if (!anyOk) parts.push(any.map(([a, v]) => `${ABILITIES[a]} ${v}`).join(" or "));
  return parts.join(", plus ");
}

// ---------- resolve ----------
// Two passes: the first finds the ability increases, the second evaluates formulas
// (resource maximums, bonuses) against the final ability scores.
export function resolve(build, pack) {
  build = normalizeBuild(build);
  const first = resolvePass(build, pack, null);
  return resolvePass(build, pack, finalScores(build, first));
}

function resolvePass(build, pack, scores) {
  const out = {
    decisions: { class: [], background: [], species: [], abilities: [], spells: [], details: [] },
    features: [], proficiencies: { skill: [], save: [], armor: [], weapon: [], tool: [], language: [] },
    expertise: [], stats: {}, resources: {}, spells: [], feats: [], warnings: [], missing: new Set(),
    asi: [], notes: [], acFormulas: [], conditionalStats: [], advantages: [], resistances: [], unarmed: [], damageBonuses: [],
    sources: { classes: new Set(), subclasses: new Set(), species: new Set(), backgrounds: new Set(), feats: new Set(), spells: new Set() },
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

  // Classes in the order taken. Only the first (starting) class gives its full proficiencies.
  build.classes.forEach((entry, i) => {
    const cls = pack.classes?.[entry.id];
    if (cls) walkClass(ctx, cls, entry, i === 0);
  });

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

function walkClass(ctx, cls, entry, starting) {
  const { pack, out } = ctx;
  const id = entry.id, level = entry.level;
  out.sources.classes.add(id);
  const scope = newScope({ path: `class.${id}`, step: "class", label: cls.name, levelWord: "class", classLevel: level });
  scope.castAbility = cls.spellcasting?.ability;
  scope.cls = cls;
  scope.starting = starting;
  // A starting class gives everything in its proficiencies block. A class added later gives only
  // its multiclass block: no saving throws, and only the armor, weapons, tools and skills listed there.
  const p = starting ? (cls.proficiencies ?? {}) : (cls.multiclass?.proficiencies ?? {});
  const source = starting ? cls.name : `${cls.name} (multiclass)`;
  if (starting) for (const s of p.saves ?? []) out.proficiencies.save.push({ value: s, source });
  for (const a of p.armor ?? []) out.proficiencies.armor.push({ value: a, source });
  for (const w of p.weapons ?? []) out.proficiencies.weapon.push({ value: w, source });
  for (const t of p.tools ?? []) out.proficiencies.tool.push({ value: t, source });
  if (p.skills) {
    walk(ctx, [{ type: "choice", id: starting ? "skills" : "multiclass_skills", label: `${cls.name} skills`, choose: p.skills.choose, from: p.skills.from, each: { type: "proficiency", kind: "skill" } }],
      scope, out.decisions.class);
  }
  if (!starting && p.tool_choice) {
    walk(ctx, [{ type: "choice", id: "multiclass_tools", label: `${cls.name} tools`, choose: p.tool_choice.choose, from: p.tool_choice.from, each: { type: "proficiency", kind: "tool" } }],
      scope, out.decisions.class);
  }

  for (let l = 1; l <= level; l++) {
    const grants = cls.levels?.[l] ?? [];
    walk(ctx, grants, { ...scope, at: l }, out.decisions.class, l);
  }

  // Subclass
  const subLevel = cls.subclass_level ?? 3;
  if (level >= subLevel) {
    const subs = Object.entries(pack.subclasses ?? {}).filter(([, s]) => s.class === id);
    const key = `class.${id}/subclass`;
    const chosen = entry.subclass && pack.subclasses?.[entry.subclass]?.class === id ? entry.subclass : null;
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
      subScope.cls = cls;
      subScope.starting = starting;
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
    const named = ctx.build.classes.length > 1 ? `${cls.name} ` : "";
    if (cantrips) walk(ctx, [{ type: "choice", id: "class_cantrips", label: named ? `${named}cantrips` : "Cantrips", choose: cantrips, from: { pool: "spells", lists: sc.list, level: 0, exclude_known: true }, each: castWith }],
      { ...scope, step: "spells" }, out.decisions.spells);
    if (prepared && maxLvl) walk(ctx, [{ type: "choice", id: "class_prepared", label: `${named}${named ? "prepared spells" : "Prepared spells"}`, choose: prepared, swap: "long_rest",
      from: { pool: "spells", lists: sc.list, min_level: 1, max_level: maxLvl, exclude_known: true }, each: castWith }],
      { ...scope, step: "spells" }, out.decisions.spells);
  }
}

// Walk a list of grants. `into` collects decisions; nested decisions go into a parent's children.
function walk(ctx, grants, scope, into, classLevel = null) {
  for (const g of grants ?? []) {
    if (!g || typeof g !== "object") continue;
    if (g.at_level && g.at_level > (scope.classLevel ?? ctx.level)) continue;
    if (g.starting_only && scope.starting === false) continue; // core traits a multiclassed class doesn't give
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
      // Features marked unique (Extra Attack, Unarmored Defense) don't stack when two classes give them.
      if (g.unique && out.features.some(f => f.name === g.name)) {
        out.notes.push({ text: `${g.name} from ${source} doesn't stack with the one you already have.` });
        break;
      }
      const variant = g.by_choice ? asArray(scope.choices.get(g.by_choice))[0] : null;
      const lvl = scope.classLevel ?? ctx.level;
      const cond = g.while ?? null;
      const stats = (g.stats ?? []).map(st => ({ label: st.label, value: evalTemplate(st.value, ctx, scope) }));
      const die = g.dice ? diceAt(g.dice, lvl) : null;
      out.features.push({
        name: g.name, text: variant && g.variants ? g.variants[variant] : g.text, source,
        action: g.action, uses: g.uses ? { ...g.uses, max: evalFormula(g.uses.max, ctx, scope) } : null,
        dice: g.dice, die, stats, while: cond, bonus: g.bonus, key: `${scope.path}/${g.name}`, level: classLevel ?? null,
      });
      for (const a of g.advantage ?? []) out.advantages.push({ ...a, source: g.name, while: a.while ?? cond });
      if (g.resistances?.length) out.resistances.push({ damage: g.resistances, source: g.name, while: cond });
      if (g.unarmed_strike) out.unarmed.push({ source: g.name, die: evalTemplate(g.unarmed_strike.die, ctx, scope), abilities: g.unarmed_strike.abilities ?? ["str"] });
      if (g.damage_bonus) out.damageBonuses.push({ source: g.name, value: evalFormula(g.damage_bonus.value, ctx, scope), abilities: g.damage_bonus.abilities ?? null, while: cond });
      if (g.bonus?.checks) (out.bonuses ??= []).push({ checks: g.bonus.checks, value: evalFormula(g.bonus.value, ctx, scope), source: g.name });
      if (g.bonus?.initiative != null) out.initiativeBonus = (out.initiativeBonus ?? 0) + (evalFormula(g.bonus.initiative, ctx, scope) ?? 0);
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
      // Bonuses that only apply out of armor (Unarmored Movement, Fast Movement) are still added here;
      // the sheet takes them back off when its armor toggles say they don't apply.
      if (g.requires) out.conditionalStats.push({ stat: g.stat, value: v, requires: g.requires, source });
      const cur = out.stats[g.stat];
      if (g.mode === "max") out.stats[g.stat] = Math.max(cur ?? 0, v);
      else if (g.mode === "add") out.stats[g.stat] = (cur ?? 0) + v;
      else out.stats[g.stat] = v;
      break;
    }
    case "ac_formula":
      out.acFormulas.push({ name: g.name ?? source, base: g.base ?? 10, add: g.add ?? [], armor: g.armor ?? "none", shield: g.shield !== false, source });
      break;
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
    always_prepared: !!g.always_prepared,
    free_cast: g.free_cast ? { ...g.free_cast, uses: evalFormula(g.free_cast.uses ?? 1, ctx, scope) } : null,
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
  featScope.cls = scope.cls;
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
    case "proficiency": {
      // kind "auto" lets one pick mix skills and tools (the Skilled feat).
      const kind = each.kind === "auto" ? (value in SKILLS ? "skill" : "tool") : each.kind;
      out.proficiencies[kind]?.push({ value, source });
      break;
    }
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

const signedStr = n => (n >= 0 ? `+${n}` : `${n}`);
const prettyValue = v => (v in ABILITIES ? ABILITIES[v] : titleCase(v));

// ---------- formulas ----------
function evalFormula(f, ctx, scope) {
  if (typeof f === "number") return f;
  if (typeof f !== "string") return null;
  // Formulas read the class they belong to; anything outside a class uses the starting class.
  const cls = scope.cls ?? ctx.pack.classes?.[ctx.build.classes[0]?.id];
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

// "Text with {formula} parts". A part that is just `table.<column>` keeps its raw value, so dice
// columns like "1d10" come through as text.
function evalTemplate(t, ctx, scope) {
  if (t == null) return null;
  if (typeof t === "number") return t;
  const cls = scope.cls ?? ctx.pack.classes?.[ctx.build.classes[0]?.id];
  const lvl = scope.classLevel ?? ctx.level;
  return String(t).replace(/\{([^}]+)\}/g, (_, expr) => {
    const e = expr.trim();
    const m = e.match(/^table\.(\w+)$/);
    if (m) return String(cls?.table?.[m[1]]?.[lvl - 1] ?? "");
    const v = evalFormula(e, ctx, scope);
    return v == null ? "?" : String(v);
  });
}

// Scaling dice like { 1: 1d6, 5: 1d8 }: the entry for the highest level reached.
function diceAt(dice, level) {
  let out = null;
  for (const [k, v] of Object.entries(dice).sort(([a], [b]) => Number(a) - Number(b))) if (level >= Number(k)) out = v;
  return out;
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
  if (!build.classes.length) w.push({ step: "class", text: "Choose a class." });
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
  for (const c of build.classes) if (!pack.classes?.[c.id]) w.push({ step: "class", text: `${titleCase(c.id)} isn't in this content pack anymore.` });

  // Multiclassing: every class needs its prerequisite, including the starting class.
  const ids = build.classes.map(c => c.id);
  if (new Set(ids).size !== ids.length) w.push({ step: "class", text: "The same class is listed twice. Combine those levels into one entry." });
  if (build.classes.length > 1) {
    for (const c of build.classes) {
      const cls = pack.classes?.[c.id];
      const problem = cls && multiclassProblem(cls, scores);
      if (problem) w.push({ step: "class", text: `Multiclassing with ${cls.name} needs ${problem}.` });
    }
  }
  if (build.level > 20) w.push({ step: "class", text: `Your class levels add up to ${build.level}, above the maximum of 20.` });
  for (const n of out.notes) w.push({ step: "review", text: n.text, info: true });
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
  build = normalizeBuild(build);
  const level = Math.min(20, build.level || 1);
  const classes = build.classes.map(c => ({ ...c, entry: pack.classes?.[c.id] })).filter(c => c.entry);
  const cls = classes[0]?.entry;
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

  // Hit points: the starting class's die in full at level 1, then the fixed average of each
  // class's own die for every other level (including the first level of an added class).
  const perLevel = hd => Math.max(1, Math.floor(hd / 2) + 1 + mods.con);
  const hpBonus = (res.stats.hp_per_level ?? 0) * level; // Tough, Dwarven Toughness
  let hp = null;
  if (cls) {
    const hd0 = cls.hit_die ?? 8;
    hp = Math.max(1, hd0 + mods.con) + hpBonus;
    classes.forEach((c, i) => { hp += perLevel(c.entry.hit_die ?? 8) * (c.level - (i === 0 ? 1 : 0)); });
  }
  const hitDice = [];
  for (const c of classes) {
    const die = c.entry.hit_die ?? 8;
    const row = hitDice.find(h => h.die === die);
    if (row) row.count += c.level; else hitDice.push({ die, count: c.level });
  }
  hitDice.sort((a, b) => b.die - a.die);

  // Spellcasting: one combined slot table across classes, Pact Magic kept separate.
  const casters = classes.filter(c => c.entry.spellcasting && c.entry.spellcasting.progression !== "none")
    .map(c => ({ id: c.id, name: c.entry.name, level: c.level, ...c.entry.spellcasting }));
  const spellcasting = casters.length ? (() => {
    const first = casters[0];
    const pact = casters.find(c => c.progression === "pact");
    return {
      ability: first.ability, dc: 8 + pb + mods[first.ability], attack: pb + mods[first.ability],
      slots: multiclassSlots(casters),
      pact: pact ? pactSlots(pact.level) : null,
      classes: casters.map(c => ({ id: c.id, name: c.name, ability: c.ability, dc: 8 + pb + mods[c.ability], attack: pb + mods[c.ability] })),
    };
  })() : null;

  const resources = Object.values(res.resources).map(r => ({
    id: r.id, name: r.name, recharge: r.recharge, short_rest_regain: r.short_rest_regain ?? null, source: r.source,
    max: r.max,
  }));

  // Only the starting class gives starting equipment.
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

  // Armor Class: every way this character can calculate it. The sheet picks one (best by default),
  // filtered by its armor and shield toggles. "No armor" (10 + Dex) is always available.
  const acOptions = [{ name: "No armor", value: 10 + mods.dex, armor: "none", shield: true, source: "Core rules" },
    ...res.acFormulas.map(a => ({ ...a, value: a.base + a.add.reduce((n, ab) => n + mods[ab], 0) }))];

  // Advantages: marked on saves and skills, plus a list for the conditional ones.
  const advFor = (on, ability, skill) => res.advantages.filter(a => a.on === on
    && (!a.abilities || a.abilities.includes(ability)) && (!a.skills || (skill && a.skills.includes(skill))));
  const advNote = a => (a.vs ? `against ${a.vs}` : a.while ? `while ${a.while}` : null);
  for (const sv of saves) sv.advantage = advFor("save", sv.ability).map(a => ({ source: a.source, note: advNote(a) }));
  for (const sk of skills) sk.advantage = advFor("check", sk.ability, sk.name).map(a => ({ source: a.source, note: advNote(a) }));

  // Unarmed Strike: everyone has one (1 + Str). Features like Martial Arts swap the die and ability.
  const unarmedSources = res.unarmed.length ? res.unarmed : [{ source: "Core rules", die: null, abilities: ["str"] }];
  const best = unarmedSources.map(u => {
    const ab = u.abilities.reduce((x, y) => (mods[y] > mods[x] ? y : x), u.abilities[0]);
    return { ...u, ability: ab, mod: mods[ab] };
  }).sort((a, b) => b.mod - a.mod || (b.die ? 1 : 0) - (a.die ? 1 : 0))[0];
  const dmgBonuses = res.damageBonuses.filter(d => !d.abilities || d.abilities.includes(best.ability));
  const unarmed = {
    name: "Unarmed Strike", attack: pb + best.mod, ability: best.ability,
    damage: best.die ? `${best.die}${best.mod ? signedStr(best.mod) : ""}` : String(Math.max(1, 1 + best.mod)),
    type: "Bludgeoning", source: best.source,
    notes: dmgBonuses.map(d => `${signedStr(d.value)} ${d.while ? `while ${d.while}` : ""} (${d.source})`.replace(/\s+/g, " ")),
  };

  return {
    initiativeAdvantage: res.advantages.filter(a => a.on === "initiative").map(a => ({ source: a.source, note: a.vs ? `against ${a.vs}` : a.while ? `while ${a.while}` : null })),
    acOptions, unarmed, conditionalStats: res.conditionalStats, resistances: res.resistances, advantages: res.advantages,
    level, scores, mods, pb, skills, saves, hp, hitDie: cls?.hit_die ?? 8, hitDice,
    classes: classes.map(c => ({ id: c.id, name: c.entry.name, level: c.level, subclass: c.subclass, subclassName: pack.subclasses?.[c.subclass]?.name ?? null })),
    ac: Math.max(...acOptions.filter(o => o.armor === "none").map(o => o.value)), initiative: mods.dex + (res.initiativeBonus ?? 0),
    speed: res.stats.speed ?? 30, darkvision: res.stats.darkvision ?? 0, size: res.stats.size, creatureType: res.stats.creature_type,
    passivePerception: 10 + skills.find(s => s.name === "Perception").bonus,
    proficiencies: res.proficiencies, features: res.features, feats: res.feats, resources, spells, spellcasting, gold,
  };
}
