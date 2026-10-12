// Turns content-pack entries into readable HTML for the compendium.
import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.js";
import { profBonus, spellSlots, pactSlots, ABILITIES, ABBR } from "./rules.js";

export const KINDS = [
  { key: "classes", one: "Class", many: "Classes", path: "classes" },
  { key: "subclasses", one: "Subclass", many: "Subclasses", path: "subclasses" },
  { key: "species", one: "Species", many: "Species", path: "species" },
  { key: "backgrounds", one: "Background", many: "Backgrounds", path: "backgrounds" },
  { key: "feats", one: "Feat", many: "Feats", path: "feats" },
  { key: "spells", one: "Spell", many: "Spells", path: "spells" },
];

// ---------- small helpers ----------
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const md = text => (text ? DOMPurify.sanitize(marked.parse(String(text))) : "");
const mdInline = text => (text ? DOMPurify.sanitize(marked.parseInline(String(text))) : "");
export const titleCase = s => String(s ?? "").replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
const ordinal = n => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const listJoin = (arr, word = "and") => arr.length < 2 ? arr.join("") : `${arr.slice(0, -1).join(", ")} ${word} ${arr.at(-1)}`;
const isAbility = v => typeof v === "string" && v in ABILITIES;
const prettyValue = v => isAbility(v) ? ABBR[v] : titleCase(v);

export const spellLevelLabel = lvl => lvl === 0 ? "Cantrip" : `Level ${lvl}`;

export function prettyFormula(f) {
  if (typeof f === "number") return String(f);
  if (typeof f !== "string") return "";
  const minOne = f.match(/^\s*max\(\s*1\s*,\s*(\w+)_mod\s*\)\s*$/);
  if (minOne && minOne[1] in ABBR) return `${ABBR[minOne[1]]} modifier (min 1)`;
  return f
    .replace(/table\.(\w+)/g, (_, c) => `${titleCase(c)} column`)
    .replace(/\b(str|dex|con|int|wis|cha)_mod\b/g, (_, a) => `${ABBR[a]} modifier`)
    .replace(/\bspell_mod\b/g, "spellcasting modifier")
    .replace(/\bclass_level\b/g, "class level")
    .replace(/\bprof\b/g, "proficiency bonus")
    .replace(/\blevel\b(?! column)/g, "character level");
}

function prettyRef(v, what = "") {
  if (typeof v !== "string" || !v.startsWith("$")) return null;
  const [scope, name] = v.slice(1).split(".");
  if (scope === "param") return `the ${what || titleCase(name).toLowerCase()} set by whatever grants this`;
  if (/ability/.test(name)) return "the ability you chose";
  if (/list/.test(name)) return "the spell list you chose";
  return "your earlier choice";
}

const RECHARGE = { short: "a short or long rest", long: "a long rest", dawn: "dawn", none: "never (doesn't recharge)" };
const PER = { short: "short rest", long: "long rest", dawn: "day" };
const ACTION = { action: "Action", bonus: "Bonus action", reaction: "Reaction", free: "Free" };

// ---------- references between entries ----------
function makeLinker(pack) {
  return (kindKey, id, label) => {
    const entry = pack[kindKey]?.[id];
    const path = KINDS.find(k => k.key === kindKey).path;
    if (!entry) return `<span class="missing" title="Not in this content pack yet">${esc(label ?? titleCase(id))}</span>`;
    return `<a href="#/${path}/${encodeURIComponent(id)}">${esc(label ?? entry.name ?? id)}</a>`;
  };
}

// Collect every choice in an entry so later features can name the options of earlier choices.
function indexChoices(node, map = new Map()) {
  if (Array.isArray(node)) node.forEach(n => indexChoices(n, map));
  else if (node && typeof node === "object") {
    if (node.type === "choice" && node.id) {
      map.set(node.id, { label: node.label, options: Object.fromEntries((node.options ?? []).map(o => [o.id, o.name])) });
    }
    Object.values(node).forEach(v => indexChoices(v, map));
  }
  return map;
}

// ---------- grants ----------
function atLevel(g, levelWord) {
  return g.at_level ? `<span class="at-level">${esc(levelWord)} ${g.at_level}</span>` : "";
}

function line(kindLabel, body, g, levelWord) {
  return `<div class="grant-line"><span class="grant-kind">${esc(kindLabel)}</span><span class="grant-body">${atLevel(g, levelWord)}${body}</span></div>`;
}

function spellTags(g) {
  const tags = [];
  if (g.always_prepared) tags.push("always prepared");
  if (g.free_cast) tags.push(`cast ${g.free_cast.uses === 1 ? "once" : `${g.free_cast.uses} times`} per ${PER[g.free_cast.recharge] ?? g.free_cast.recharge} without a slot`);
  if (g.cast_ability) tags.push(`cast with ${prettyRef(g.cast_ability) ?? ABILITIES[g.cast_ability] ?? g.cast_ability}`);
  return tags;
}

function describeEach(each) {
  if (!each) return "";
  switch (each.type) {
    case "spells": {
      const tags = spellTags(each);
      return `You learn each spell you pick${tags.length ? ` (${esc(tags.join("; "))})` : ""}.`;
    }
    case "proficiency": return `You gain proficiency (${esc(each.kind)}) in each pick.`;
    case "expertise": return "You gain expertise in each pick.";
    case "feat": return "You gain the feat you pick.";
    default: return "";
  }
}

function describeQuery(q, link) {
  if (q.pool === "spells") {
    const what = q.level === 0 ? "cantrips" : q.level != null ? `${ordinal(q.level)}-level spells` : "spells";
    const listRef = prettyRef(q.lists);
    const lists = listRef ?? `the ${listJoin([].concat(q.lists ?? []).map(titleCase), "or")} list`;
    return q.lists ? `${what} from ${esc(lists)}` : what;
  }
  if (q.pool === "feats") {
    const cat = q.category ? `${titleCase(q.category).replace(/ Feats?$/, "")} feats` : "feats";
    return esc(cat.replace("Epic Boon feats", "Epic Boons"));
  }
  return esc(titleCase(q.pool));
}

export function renderGrants(grants, ctx) {
  if (!Array.isArray(grants) || !grants.length) return "";
  return `<div class="grants">${grants.map(g => renderGrant(g, ctx)).join("")}</div>`;
}

function renderGrant(g, ctx) {
  const { link, levelWord } = ctx;
  if (!g || typeof g !== "object") return "";
  switch (g.type) {
    case "feature": {
      const tags = [];
      if (g.action) tags.push(ACTION[g.action] ?? titleCase(g.action));
      if (g.uses) tags.push(`${prettyFormula(g.uses.max)} per ${PER[g.uses.recharge] ?? g.uses.recharge}`);
      let extra = "";
      if (g.dice) {
        const steps = Object.entries(g.dice).sort((a, b) => a[0] - b[0]).map(([lvl, d]) => `${esc(d)} at ${esc(levelWord.toLowerCase())} ${lvl}`);
        extra += `<p class="scaling">Damage or healing dice: ${steps.join(", ")}</p>`;
      }
      if (g.bonus) extra += `<p class="scaling">Bonus: +${esc(prettyFormula(g.bonus.value))} to ${esc(listJoin(g.bonus.checks ?? []))} checks</p>`;
      if (g.variants) {
        const choice = ctx.choices.get(g.by_choice);
        extra += `<dl class="variants">${Object.entries(g.variants).map(([opt, text]) =>
          `<dt>If you chose ${esc(choice?.options[opt] ?? titleCase(opt))}</dt><dd>${mdInline(text)}</dd>`).join("")}</dl>`;
      }
      return `<section class="feature">
        <h4>${atLevel(g, levelWord)}${esc(g.name)}${tags.map(t => `<span class="tag">${esc(t)}</span>`).join("")}</h4>
        ${g.text ? `<div class="feature-text">${md(g.text)}</div>` : ""}${extra}
      </section>`;
    }
    case "proficiency":
      return line(`${titleCase(g.kind)} proficiency`, esc(listJoin((g.values ?? []).map(prettyValue))), g, levelWord);
    case "expertise":
      return line("Expertise", esc(listJoin((g.values ?? []).map(prettyValue))), g, levelWord);
    case "stat": {
      const v = g.value;
      const body = g.stat === "darkvision" ? `Darkvision ${v} ft`
        : g.stat === "speed" ? `${g.mode === "add" ? `+${v}` : v} ft`
        : esc(Array.isArray(v) ? v.join(" or ") : v);
      return line(g.stat === "darkvision" ? "Sense" : titleCase(g.stat), esc(body), g, levelWord);
    }
    case "resource": {
      const bits = [`maximum ${prettyFormula(g.max)}`, `recharges on ${RECHARGE[g.recharge] ?? g.recharge}`];
      if (g.short_rest_regain) bits.push(`regain ${g.short_rest_regain} on a short rest`);
      return line("Resource", `<strong>${esc(g.name)}</strong>: ${esc(bits.join("; "))}`, g, levelWord);
    }
    case "spells": {
      const names = (g.ids ?? []).map(id => link("spells", id)).join(", ");
      const tags = spellTags(g);
      return line("Spells", `${names}${tags.length ? ` <span class="note">(${esc(tags.join("; "))})</span>` : ""}`, g, levelWord);
    }
    case "asi": {
      if (g.mode === "background") {
        const abs = (g.abilities ?? []).map(a => ABBR[a] ?? a);
        return line("Ability scores", `+2 to one and +1 to another, or +1 to all three: ${esc(listJoin(abs))}`, g, levelWord);
      }
      return line("Ability scores", esc(`Spend ${g.points} points (up to +${g.max_per_ability ?? g.points} per ability, max ${g.cap ?? 20})`), g, levelWord);
    }
    case "feat": {
      const params = Object.entries(g.params ?? {}).map(([k, v]) => k === "list" ? `${titleCase(v)} list` : `${titleCase(k)}: ${titleCase(v)}`);
      return line("Feat", `${link("feats", g.id)}${params.length ? ` <span class="note">(${esc(params.join(", "))})</span>` : ""}`, g, levelWord);
    }
    case "subclass": {
      const subs = ctx.subclasses ?? [];
      return line("Subclass", `Choose your subclass${subs.length ? `: ${subs.map(s => link("subclasses", s.id)).join(", ")}` : ""}`, g, levelWord);
    }
    case "choice":
      return renderChoice(g, ctx);
    default:
      return line(titleCase(g.type), `<code>${esc(JSON.stringify(g))}</code>`, g, levelWord);
  }
}

function renderChoice(g, ctx) {
  const notes = [];
  if (g.fixed_by) notes.push("Skipped when whatever grants this already sets it, like a background naming the list.");
  if (g.default) notes.push(`Default: ${prettyValue(g.default)}.`);
  if (g.swap === "level_up") notes.push("You can change this pick when you gain a level.");
  if (g.swap === "long_rest") notes.push("You can change this pick after a long rest.");

  let body = "";
  if (Array.isArray(g.from)) {
    body = `<ul class="chips">${g.from.map(v => `<li>${esc(prettyValue(v))}</li>`).join("")}</ul>`;
  } else if (g.from) {
    body = `<p>Pick ${describeQuery(g.from, ctx.link)}.</p>`;
  }
  if (g.options) {
    body += `<div class="options">${g.options.map(o => `
      <div class="option">
        <h5>${esc(o.name)}</h5>
        ${o.text ? `<div class="option-text">${md(o.text)}</div>` : ""}
        ${renderGrants(o.grants, ctx)}
      </div>`).join("")}</div>`;
  }
  const each = describeEach(g.each);
  return `<div class="choice">
    <p class="choice-head">${atLevel(g, ctx.levelWord)}<strong>${esc(g.label ?? titleCase(g.id))}</strong><span class="choose">choose ${g.choose ?? 1}</span></p>
    ${body}${each ? `<p class="each">${each}</p>` : ""}
    ${notes.map(n => `<p class="note">${esc(n)}</p>`).join("")}
  </div>`;
}

// ---------- entries ----------
function head(entry, subtitle) {
  return `<header class="entry-head">
    <h1>${esc(entry.name ?? entry.id)}</h1>
    <p class="meta">${subtitle ? `<span>${subtitle}</span>` : ""}${entry.source ? `<span>${esc(entry.source)}</span>` : ""}${entry.homebrew ? `<span class="badge">Homebrew</span>` : ""}</p>
  </header>`;
}

function facts(rows) {
  const filled = rows.filter(([, v]) => v);
  return filled.length ? `<dl class="facts">${filled.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>` : "";
}

function equipment(options) {
  if (!Array.isArray(options) || !options.length) return "";
  return `<h2>Starting equipment</h2><ul class="equipment">${options.map(o =>
    `<li><strong>Option ${esc(o.label)}</strong> ${o.items ? `${esc(o.items)}${o.gold ? `, and ${o.gold} GP` : ""}` : `${o.gold ?? 0} GP`}</li>`).join("")}</ul>`;
}

const intro = entry => {
  if (!entry.text) return "";
  const name = (entry.name ?? "").trim().toLowerCase();
  const text = entry.text.replace(/^#{1,3}\s+(.+)\n*/, (m, h) => h.trim().toLowerCase() === name ? "" : m);
  return text.trim() ? `<div class="intro">${md(text)}</div>` : "";
};

function labelOf(g) {
  if (g.type === "feature" || g.type === "resource") return g.name;
  if (g.type === "choice") return g.label ?? titleCase(g.id);
  if (g.type === "subclass") return "Subclass";
  return null;
}

function classTable(cls, subclasses) {
  const cols = Object.keys(cls.table ?? {});
  const sc = cls.spellcasting;
  const subLevels = new Set(subclasses.flatMap(s => Object.keys(s.levels ?? {}).map(Number)));
  let slotCols = 0;
  if (sc && ["full", "half", "third"].includes(sc.progression)) slotCols = spellSlots(sc.progression, 20).length;
  const pact = sc?.progression === "pact";

  const header = `<tr><th scope="col">Level</th><th scope="col">Prof.</th><th scope="col" class="feat-col">Features</th>
    ${cols.map(c => `<th scope="col">${esc(titleCase(c))}</th>`).join("")}
    ${pact ? `<th scope="col">Pact slots</th><th scope="col">Slot level</th>` : ""}
    ${Array.from({ length: slotCols }, (_, i) => `<th scope="col" class="slot">${ordinal(i + 1)}</th>`).join("")}</tr>`;

  const rows = Array.from({ length: 20 }, (_, i) => {
    const lvl = i + 1;
    const grants = cls.levels?.[lvl] ?? [];
    const names = grants.map(labelOf).filter(Boolean);
    if (subLevels.has(lvl) && !grants.some(g => g.type === "subclass")) names.push("Subclass feature");
    const slots = slotCols ? spellSlots(sc.progression, lvl) : [];
    const p = pact ? pactSlots(lvl) : null;
    return `<tr>
      <th scope="row">${lvl}</th><td>+${profBonus(lvl)}</td><td class="feat-col">${names.length ? esc(names.join(", ")) : "—"}</td>
      ${cols.map(c => `<td>${cls.table[c][i] ? esc(cls.table[c][i]) : "—"}</td>`).join("")}
      ${p ? `<td>${p.count}</td><td>${ordinal(p.level)}</td>` : ""}
      ${Array.from({ length: slotCols }, (_, s) => `<td class="slot">${slots[s] ?? "—"}</td>`).join("")}
    </tr>`;
  }).join("");
  return `<h2>Class table</h2><div class="table-wrap"><table class="class-table"><thead>${header}</thead><tbody>${rows}</tbody></table></div>`;
}

function levelSections(levels, ctx, word) {
  return Object.keys(levels ?? {}).map(Number).sort((a, b) => a - b)
    .filter(l => (levels[l] ?? []).length)
    .map(l => `<section class="level"><h3>${esc(word)} ${l}</h3>${renderGrants(levels[l], ctx)}</section>`).join("");
}

export function renderEntry(kindKey, entry, pack) {
  const link = makeLinker(pack);
  const choices = indexChoices(entry);
  const ctx = { link, choices, levelWord: "Level" };

  switch (kindKey) {
    case "classes": {
      const subclasses = Object.values(pack.subclasses ?? {}).filter(s => s.class === entry.id).sort((a, b) => a.name.localeCompare(b.name));
      const p = entry.proficiencies ?? {};
      const sc = entry.spellcasting;
      const mc = entry.multiclass;
      const prog = { full: "Full caster", half: "Half caster", third: "Third caster", pact: "Pact Magic" };
      const mcReq = mc?.prereq?.ability ? listJoin(Object.entries(mc.prereq.ability).map(([a, v]) => `${ABBR[a]} ${v}`)) : "";
      const mcProf = mc?.proficiencies ? [...(mc.proficiencies.armor ?? []), ...(mc.proficiencies.weapons ?? [])] : [];
      ctx.subclasses = subclasses;
      ctx.levelWord = "Level";
      return `<article class="entry">${head(entry, "Class")}${intro(entry)}
        ${facts([
          ["Hit die", entry.hit_die ? `d${entry.hit_die}` : ""],
          ["Primary ability", esc(listJoin((entry.primary_ability ?? []).map(a => ABILITIES[a] ?? a), "or"))],
          ["Saving throws", esc(listJoin((p.saves ?? []).map(a => ABILITIES[a] ?? a)))],
          ["Armor", esc(listJoin(p.armor ?? []))],
          ["Weapons", esc(listJoin(p.weapons ?? []))],
          ["Tools", esc(listJoin(p.tools ?? []))],
          ["Skills", p.skills ? esc(`Choose ${p.skills.choose}: ${listJoin(p.skills.from ?? [], "or")}`) : ""],
          ["Spellcasting", sc ? esc(`${ABILITIES[sc.ability] ?? sc.ability}, ${(prog[sc.progression] ?? sc.progression).toLowerCase()}, ${titleCase(sc.list)} list${sc.focus ? `, focus: ${sc.focus}` : ""}`) : ""],
          ["Multiclassing", mc ? esc(`${mcReq ? `Requires ${mcReq}` : "No requirement"}${mcProf.length ? `; you gain ${listJoin(mcProf)}` : ""}`) : ""],
        ])}
        ${equipment(entry.starting_equipment)}
        ${classTable(entry, subclasses)}
        ${subclasses.length ? `<h2>Subclasses</h2><ul class="link-list">${subclasses.map(s => `<li>${link("subclasses", s.id)}</li>`).join("")}</ul>` : ""}
        <h2>Features</h2>${levelSections(entry.levels, ctx, "Level")}
      </article>`;
    }
    case "subclasses": {
      const cls = pack.classes?.[entry.class];
      const clsName = cls?.name ?? titleCase(entry.class);
      return `<article class="entry">${head(entry, `${link("classes", entry.class, clsName)} subclass`)}${intro(entry)}
        <h2>Features</h2>${levelSections(entry.levels, ctx, `${clsName} level`)}
      </article>`;
    }
    case "species":
      ctx.levelWord = "Character level";
      return `<article class="entry">${head(entry, "Species")}${intro(entry)}
        ${facts([
          ["Creature type", esc(entry.creature_type)],
          ["Size", esc(listJoin([].concat(entry.size ?? []), "or"))],
          ["Speed", entry.speed ? `${esc(entry.speed)} ft` : ""],
        ])}
        <h2>Traits</h2>${renderGrants(entry.grants, ctx)}
      </article>`;
    case "backgrounds":
      ctx.levelWord = "Character level";
      return `<article class="entry">${head(entry, "Background")}${intro(entry)}
        <h2>What you gain</h2>${renderGrants(entry.grants, ctx)}
        ${equipment(entry.starting_equipment)}
      </article>`;
    case "feats": {
      ctx.levelWord = "Character level";
      const pr = entry.prereq ?? {};
      const prBits = [];
      if (pr.level) prBits.push(`level ${pr.level}+`);
      if (pr.ability) prBits.push(listJoin(Object.entries(pr.ability).map(([a, v]) => `${ABBR[a]} ${v}+`), "or"));
      if (pr.proficiency) prBits.push(`proficiency with ${listJoin([].concat(pr.proficiency))}`);
      if (pr.feature) prBits.push(titleCase(pr.feature));
      const repeatLabel = entry.repeat_key ? choices.get(entry.repeat_key)?.label : null;
      return `<article class="entry">${head(entry, `${esc(titleCase(entry.category ?? "general"))} feat`)}${intro(entry)}
        ${facts([
          ["Prerequisite", esc(prBits.join("; "))],
          ["Repeatable", entry.repeatable ? esc(`Yes${repeatLabel ? `, with a different ${repeatLabel.toLowerCase()} each time` : ""}`) : ""],
        ])}
        <h2>Benefits</h2>${renderGrants(entry.grants, ctx)}
      </article>`;
    }
    case "spells": {
      const lvlLine = entry.level === 0 ? `${esc(entry.school)} cantrip` : `Level ${esc(entry.level)} ${esc(entry.school)}`;
      const comps = [].concat(entry.components ?? []).join(", ") + (entry.material ? ` (${entry.material})` : "");
      const classes = Object.values(pack.classes ?? {}).filter(c => [].concat(entry.lists ?? []).includes(c.spellcasting?.list));
      return `<article class="entry">${head(entry, lvlLine)}
        ${facts([
          ["Casting time", esc(`${entry.casting_time ?? ""}${entry.ritual ? " or Ritual" : ""}`)],
          ["Range", esc(entry.range)],
          ["Components", esc(comps)],
          ["Duration", esc(`${entry.concentration ? "Concentration, " : ""}${entry.duration ?? ""}`)],
          ["Spell lists", esc(listJoin([].concat(entry.lists ?? []).map(titleCase)))],
          ["Classes in this pack", classes.map(c => link("classes", c.id)).join(", ")],
        ])}
        <div class="spell-text">${md(entry.text)}</div>
      </article>`;
    }
  }
  return "";
}

export function listSecondary(kindKey, entry, pack) {
  switch (kindKey) {
    case "spells": return `${spellLevelLabel(entry.level)}${entry.school ? ` ${entry.school.toLowerCase()}` : ""}`;
    case "subclasses": return pack.classes?.[entry.class]?.name ?? titleCase(entry.class);
    case "feats": return `${titleCase(entry.category ?? "")} feat`;
    case "classes": return entry.hit_die ? `d${entry.hit_die} hit die` : "";
    case "species": return entry.speed ? `${entry.speed} ft` : "";
    default: return entry.source ?? "";
  }
}
