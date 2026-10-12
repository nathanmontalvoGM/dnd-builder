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

// Warlock Pact Magic: all slots are the same level and recharge on a short rest.
export function pactSlots(classLevel) {
  const count = classLevel >= 17 ? 4 : classLevel >= 11 ? 3 : classLevel >= 2 ? 2 : 1;
  const level = Math.min(5, Math.ceil(classLevel / 2));
  return { count, level };
}

export const ABILITIES = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
export const ABBR = { str: "Str", dex: "Dex", con: "Con", int: "Int", wis: "Wis", cha: "Cha" };
