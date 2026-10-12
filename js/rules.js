// Core 2024 rules math shared by the compendium, builder and sheet.

export const profBonus = level => 2 + Math.floor((Math.max(1, level) - 1) / 4);

// Spell slots per spell level (index 0 = 1st level) for a full caster at levels 1-20.
const FULL = [
  [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2],
  [4, 3, 3, 3, 1], [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

// 2024 half and third casters follow the full table at a reduced effective level.
export function spellSlots(progression, classLevel) {
  const eff = { full: classLevel, half: Math.ceil(classLevel / 2), third: classLevel >= 3 ? Math.ceil(classLevel / 3) : 0 }[progression];
  return eff ? FULL[eff - 1] : [];
}

// Spell slots for a character's slot-casting classes (Pact Magic is separate).
// One class: its own table. Several (2024 multiclass rule): add full-caster levels, half-caster
// levels rounded up, and third-caster levels rounded down, then read the full-caster table.
export function multiclassSlots(casters) {
  const slotted = casters.filter(c => ["full", "half", "third"].includes(c.progression));
  if (!slotted.length) return [];
  if (slotted.length === 1) return spellSlots(slotted[0].progression, slotted[0].level);
  const eff = slotted.reduce((n, c) => n + (c.progression === "full" ? c.level : c.progression === "half" ? Math.ceil(c.level / 2) : Math.floor(c.level / 3)), 0);
  return eff ? FULL[Math.min(20, eff) - 1] : [];
}

// Warlock Pact Magic: all slots are the same level and recharge on a short rest.
export function pactSlots(classLevel) {
  const count = classLevel >= 17 ? 4 : classLevel >= 11 ? 3 : classLevel >= 2 ? 2 : 1;
  const level = Math.min(5, Math.ceil(classLevel / 2));
  return { count, level };
}

export const ABILITIES = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
export const ABBR = { str: "Str", dex: "Dex", con: "Con", int: "Int", wis: "Wis", cha: "Cha" };

export const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];
export const mod = score => Math.floor((score - 10) / 2);
export const signed = n => (n >= 0 ? `+${n}` : `${n}`);

export const SKILLS = {
  Acrobatics: "dex", "Animal Handling": "wis", Arcana: "int", Athletics: "str", Deception: "cha", History: "int",
  Insight: "wis", Intimidation: "cha", Investigation: "int", Medicine: "wis", Nature: "int", Perception: "wis",
  Performance: "cha", Persuasion: "cha", Religion: "int", "Sleight of Hand": "dex", Stealth: "dex", Survival: "wis",
};

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
export const POINT_BUY = { budget: 27, cost: { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 } };

// Every 2024 character knows Common plus two standard languages.
export const STANDARD_LANGUAGES = ["Common Sign Language", "Draconic", "Dwarvish", "Elvish", "Giant", "Gnomish", "Goblin", "Halfling", "Orc"];
export const ALIGNMENTS = ["Lawful Good", "Neutral Good", "Chaotic Good", "Lawful Neutral", "Neutral", "Chaotic Neutral", "Lawful Evil", "Neutral Evil", "Chaotic Evil", "Unaligned"];

// Highest spell level a caster can prepare at a class level.
export function maxSpellLevel(progression, classLevel) {
  if (progression === "pact") return pactSlots(classLevel).level;
  return spellSlots(progression, classLevel).length;
}

export const ordinal = n => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
