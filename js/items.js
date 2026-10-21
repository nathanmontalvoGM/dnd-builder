// Magic items: plain-language descriptions of what an item does, and the custom-item editor's
// effects, which turn into the same grants an item note in the content pack would have.
import { ABILITIES, SKILLS } from "./rules.js";

export const DAMAGE_TYPES = ["Acid", "Bludgeoning", "Cold", "Fire", "Force", "Lightning", "Necrotic", "Piercing", "Poison", "Psychic", "Radiant", "Slashing", "Thunder"];
const RARITY = { common: "Common", uncommon: "Uncommon", rare: "Rare", very_rare: "Very rare", legendary: "Legendary", artifact: "Artifact" };
const TYPE = { armor: "armor", potion: "potion", ring: "ring", rod: "rod", scroll: "scroll", staff: "staff", wand: "wand", weapon: "weapon", wondrous: "wondrous item" };
const signed = n => (n >= 0 ? `+${n}` : `${n}`);
const REQ = { no_armor: "while you wear no armor", no_shield: "while you use no shield", unarmored: "while you wear no armor and use no shield", no_heavy_armor: "unless you wear heavy armor" };

export const needsAttunement = e => !!e?.attunement;

// "Rare ring, requires attunement by a spellcaster"
export function itemLine(e) {
  if (!e) return "";
  const kind = [RARITY[e.rarity], TYPE[e.item_type]].filter(Boolean).join(" ") || (e.custom ? "Custom item" : "Magic item");
  const att = e.attunement ? `requires attunement${typeof e.attunement === "string" ? ` ${e.attunement}` : ""}` : "";
  return [kind.charAt(0).toUpperCase() + kind.slice(1), att].filter(Boolean).join(", ");
}

// Every mechanical effect of an item, as short lines: "+1 AC", "Strength becomes 21", ...
export function describeItemEffects(e) {
  if (!e) return [];
  const out = (e.grants ?? []).map(describeGrant).filter(Boolean);
  if (e.weapon) {
    const w = e.weapon;
    out.unshift(`Weapon: ${w.damage ?? "1"} ${w.damage_type ?? ""}${w.bonus ? `, ${signed(w.bonus)} to attack and damage` : ""}${w.extra ? `, plus ${w.extra}` : ""}${w.properties ? ` (${w.properties})` : ""}`.replace(/\s+,/g, ","));
  }
  if (e.armor) {
    const a = e.armor;
    out.unshift(a.type === "shield" ? `Shield: +${2 + (a.bonus ?? 0)} AC` : `${a.type[0].toUpperCase() + a.type.slice(1)} armor: AC ${a.ac}${a.type === "light" ? " + Dex" : a.type === "medium" ? " + Dex (max 2)" : ""}${a.bonus ? `, ${signed(a.bonus)}` : ""}`);
  }
  return out;
}

// "zone-of-truth" -> "Zone of Truth", for spells the pack has no note for yet.
const SMALL = new Set(["of", "the", "and", "or", "from", "to", "a", "an", "with", "in", "on", "for"]);
const spellName = id => id.split("-").map((w, i) => i && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

export function describeGrant(g) {
  if (!g || typeof g !== "object") return "";
  const v = typeof g.value === "number" ? signed(g.value) : /^[+-]/.test(String(g.value)) ? String(g.value).replace(/^-/, "−") : `+${g.value}`;
  switch (g.type) {
    case "bonus": {
      const who = g.abilities?.length ? g.abilities.map(a => ABILITIES[a]).join(", ") + " " : "";
      if (g.to === "damage" && g.damage_type) return `${v} ${g.damage_type} damage on weapon hits${g.note ? ` (${g.note})` : ""}`;
      const what = {
        ac: "AC", saves: `${who}saving throws`, checks: g.skills?.length ? `${g.skills.join(", ")} checks` : `${who}ability checks`, initiative: "Initiative",
        spell_attack: "spell attack rolls", spell_dc: "spell save DC", hp_max: "Hit Point maximum", attack: "weapon attack rolls", damage: "weapon damage rolls",
        attack_rolls: "attack rolls",
      }[g.to] ?? g.to;
      return `${v} to ${what}${g.requires ? ` ${REQ[g.requires] ?? ""}` : ""}${g.note ? ` (${g.note})` : ""}`;
    }
    case "ac_min":
      return `AC can't be lower than ${g.value}`;
    case "ac_formula":
      return `AC ${g.base ?? 10}${(g.add ?? []).map(a => ` + ${ABILITIES[a]} modifier`).join("")}${g.armor === "none" ? " without armor" : ""}`;
    case "ability":
      return g.set != null ? `${ABILITIES[g.ability]} becomes ${g.set} (unless already higher)` : `${ABILITIES[g.ability]} ${signed(g.add)}${g.max ? `, maximum ${g.max}` : ""}`;
    case "stat":
      if (g.stat === "speed") return g.mode === "multiply" ? (g.value === 2 ? "Speed doubled" : g.value === 0.5 ? "Speed halved" : `Speed ×${g.value}`)
        : g.mode === "max" ? `Speed becomes ${g.value} ft (unless already higher)` : `${signed(g.value)} ft Speed`;
      if (g.stat === "darkvision") return `Darkvision ${g.value} ft`;
      return `${g.stat}: ${g.value}`;
    case "resource":
      return `${g.max} ${g.name?.toLowerCase().includes("charge") ? g.name : `uses of ${g.name}`}, back ${g.recharge === "dawn" ? "at dawn" : `on a ${g.recharge} rest`}`;
    case "spells":
      return `Spells: ${(g.ids ?? []).map(spellName).join(", ")}${g.dc ? ` (save DC ${g.dc})` : ""}`;
    case "proficiency":
      return `${g.kind[0].toUpperCase() + g.kind.slice(1)} proficiency: ${(g.values ?? []).join(", ")}`;
    case "feature": {
      const bits = [];
      if (g.resistances?.length) bits.push(`Resistance to ${g.resistances.join(", ")} damage`);
      const advWhat = a => a.skills?.length ? `${a.skills.join(", ")} checks`
        : a.on === "save" ? `${a.abilities?.length ? a.abilities.map(x => ABILITIES[x]).join(", ") + " " : ""}saving throws`
        : a.on === "check" ? `${a.abilities?.length ? a.abilities.map(x => ABILITIES[x]).join(", ") + " " : ""}ability checks`
        : a.on === "attack" ? "attack rolls" : a.on === "initiative" ? "Initiative" : a.on;
      if (g.advantage?.length) bits.push(`Advantage on ${g.advantage.map(advWhat).join(", ")}${g.advantage[0].vs ? ` (${g.advantage[0].vs})` : ""}`);
      return bits.join("; ") || "";
    }
    default:
      return "";
  }
}

// ---------- custom items ----------
// Each effect row in the editor: which fields it shows, and the grants it becomes.
export const EFFECTS = [
  { kind: "ac", label: "AC bonus", fields: ["value"] },
  { kind: "saves", label: "Saving throw bonus", fields: ["value", "ability"] },
  { kind: "checks", label: "Ability check bonus", fields: ["value"] },
  { kind: "skill", label: "Skill bonus", fields: ["value", "skill"] },
  { kind: "initiative", label: "Initiative bonus", fields: ["value"] },
  { kind: "spell", label: "Spell attack and DC bonus", fields: ["value"] },
  { kind: "hp", label: "Hit Point maximum bonus", fields: ["value"] },
  { kind: "score_set", label: "Ability score becomes", fields: ["ability", "value"] },
  { kind: "score_add", label: "Ability score increase", fields: ["ability", "value"] },
  { kind: "speed", label: "Speed bonus (ft)", fields: ["value"] },
  { kind: "darkvision", label: "Darkvision (ft)", fields: ["value"] },
  { kind: "resistance", label: "Damage resistance", fields: ["dtype"] },
  { kind: "charges", label: "Charges", fields: ["name", "value"] },
  { kind: "weapon", label: "Weapon", fields: ["dice", "dtype", "wability", "value"] },
  { kind: "armor", label: "Armor or shield", fields: ["atype", "base", "value"] },
];
export const effectDef = kind => EFFECTS.find(x => x.kind === kind) ?? EFFECTS[0];
export const newEffect = (kind = "ac") => ({ kind, value: kind === "darkvision" ? 60 : kind === "score_set" ? 19 : kind === "speed" ? 10 : kind === "charges" ? 3 : kind === "weapon" || kind === "armor" ? 0 : 1, ability: kind === "saves" ? "all" : "str", skill: "Perception", dtype: kind === "weapon" ? "Slashing" : "Fire", name: "Charges", dice: "1d8", wability: "str", atype: "light", base: 11 });

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== "" ? Math.trunc(Number(v)) : d);

// A custom item as an item entry, the same shape as one from the content pack.
export function customEntry(c, uid) {
  const grants = [];
  let weapon = null, armor = null;
  for (const fx of c.effects ?? []) {
    const v = num(fx.value);
    switch (fx.kind) {
      case "ac": grants.push({ type: "bonus", to: "ac", value: v }); break;
      case "saves": grants.push({ type: "bonus", to: "saves", value: v, ...(fx.ability && fx.ability !== "all" ? { abilities: [fx.ability] } : {}) }); break;
      case "checks": grants.push({ type: "bonus", to: "checks", value: v }); break;
      case "skill": grants.push({ type: "bonus", to: "checks", value: v, skills: [fx.skill] }); break;
      case "initiative": grants.push({ type: "bonus", to: "initiative", value: v }); break;
      case "spell": grants.push({ type: "bonus", to: "spell_attack", value: v }, { type: "bonus", to: "spell_dc", value: v }); break;
      case "hp": grants.push({ type: "bonus", to: "hp_max", value: v }); break;
      case "score_set": grants.push({ type: "ability", ability: fx.ability, set: v }); break;
      case "score_add": grants.push({ type: "ability", ability: fx.ability, add: v, max: 20 + Math.max(0, v) }); break;
      case "speed": grants.push({ type: "stat", stat: "speed", value: v, mode: "add" }); break;
      case "darkvision": grants.push({ type: "stat", stat: "darkvision", value: v, mode: "max" }); break;
      case "resistance": grants.push({ type: "feature", name: `${c.name || "Item"}: ${fx.dtype} resistance`, text: `You have Resistance to ${fx.dtype} damage.`, resistances: [fx.dtype] }); break;
      case "charges": grants.push({ type: "resource", id: `item-${uid}-${(c.effects ?? []).indexOf(fx)}`, name: `${c.name || "Item"} ${fx.name || "charges"}`, max: Math.max(1, v), recharge: "dawn" }); break;
      case "weapon": weapon = { damage: /^\d+(d\d+)?$/.test(String(fx.dice).trim()) ? String(fx.dice).trim() : "1d6", damage_type: fx.dtype, ability: fx.wability, bonus: v }; break;
      case "armor": armor = fx.atype === "shield" ? { type: "shield", bonus: v } : { type: fx.atype, ac: num(fx.base, 11), bonus: v }; break;
    }
  }
  return { id: `custom-${uid}`, name: c.name || "Custom item", custom: true, attunement: !!c.attunement, text: c.text ?? "", grants, ...(weapon ? { weapon } : {}), ...(armor ? { armor } : {}) };
}

export const SKILL_NAMES = Object.keys(SKILLS);

// ---------- the magic item picker ----------
export const ITEM_TYPES = [["armor", "Armor"], ["weapon", "Weapons"], ["ring", "Rings"], ["wand", "Wands"], ["rod", "Rods"], ["staff", "Staffs"], ["potion", "Potions"], ["scroll", "Scrolls"], ["wondrous", "Wondrous items"]];
export const RARITIES = [["common", "Common"], ["uncommon", "Uncommon"], ["rare", "Rare"], ["very_rare", "Very rare"], ["legendary", "Legendary"], ["artifact", "Artifact"], ["varies", "Varies"]];
export const rarityRank = r => { const i = RARITIES.findIndex(([k]) => k === (r ?? "varies")); return i < 0 ? RARITIES.length : i; };
// What an item does on the sheet, as filter categories.
export const EFFECT_KINDS = [["ac", "Armor Class"], ["weapon", "Weapon attack"], ["saves", "Saving throws"], ["checks", "Checks and Initiative"], ["scores", "Ability scores"],
  ["spellcasting", "Spell attack and DC"], ["spells", "Casts spells"], ["charges", "Charges or uses"], ["resist", "Resistance"], ["senses", "Speed and Darkvision"]];
export function itemEffectKinds(e) {
  const k = new Set();
  if (e?.armor) k.add("ac");
  if (e?.weapon) k.add("weapon");
  for (const g of e?.grants ?? []) {
    if (g.type === "bonus") k.add({ ac: "ac", saves: "saves", checks: "checks", initiative: "checks", spell_attack: "spellcasting", spell_dc: "spellcasting", attack: "weapon", damage: "weapon", hp_max: "scores" }[g.to] ?? "checks");
    if (g.type === "ability") k.add("scores");
    if (g.type === "spells") k.add("spells");
    if (g.type === "resource") k.add("charges");
    if (g.type === "stat" && ["speed", "darkvision"].includes(g.stat)) k.add("senses");
    if (g.type === "feature" && g.resistances?.length) k.add("resist");
    if (g.type === "feature" && g.advantage?.length) k.add(g.advantage.some(a => a.on === "save") ? "saves" : "checks");
  }
  return [...k];
}
// "400 GP", "B+4,000 GP" (the base item's cost plus 4,000) -> 400, 4000. "Varies" -> null.
export function itemPrice(e) {
  const m = String(e?.price ?? "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(GP|SP|CP|PP)?/i);
  if (!m) return null;
  return Number(m[1]) * ({ cp: 0.01, sp: 0.1, gp: 1, pp: 10 }[(m[2] ?? "gp").toLowerCase()]);
}
// "requires attunement by a Cleric or Paladin": can this character attune? Unknown requirements
// (alignment, "a creature of the weapon's choice") count as yes.
const CLASS_NAMES = ["artificer", "barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard"];
export function canAttune(e, classNames = [], speciesName = "", isCaster = false) {
  if (typeof e?.attunement !== "string") return true;
  const req = e.attunement.toLowerCase();
  const mine = classNames.map(c => c.toLowerCase());
  const named = CLASS_NAMES.filter(c => new RegExp(`\\b${c}`).test(req));
  if (named.length && named.some(c => mine.includes(c))) return true;
  if (/spellcaster/.test(req) && isCaster) return true;
  if (/\bdwarf/.test(req) && /dwarf/i.test(speciesName)) return true;
  if (/\belf\b/.test(req) && /elf/i.test(speciesName)) return true;
  return !named.length && !/spellcaster|\bdwarf|\belf\b/.test(req);
}
