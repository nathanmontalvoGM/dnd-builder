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

// 2024 conditions, in our own short wording. `speedZero` conditions set Speed to 0 on the sheet.
// Exhaustion has its own tracker, so it isn't in this list.
export const CONDITIONS = {
  Blinded: { summary: "Can't see.", rules: ["You can't see, and you automatically fail any ability check that needs sight.", "Attack rolls against you have Advantage.", "Your attack rolls have Disadvantage."] },
  Charmed: { summary: "Can't harm the charmer.", rules: ["You can't attack the charmer or target them with damaging abilities or magical effects.", "The charmer has Advantage on ability checks to interact with you socially."] },
  Deafened: { summary: "Can't hear.", rules: ["You can't hear, and you automatically fail any ability check that needs hearing."] },
  Frightened: { summary: "Disadvantage while the source is in sight.", rules: ["You have Disadvantage on ability checks and attack rolls while the source of your fear is within line of sight.", "You can't willingly move closer to the source of your fear."] },
  Grappled: { speedZero: true, summary: "Speed 0.", rules: ["Your Speed is 0 and can't increase.", "You have Disadvantage on attack rolls against any target other than the grappler.", "The grappler can drag or carry you when it moves, but every foot costs it 1 extra foot unless you're Tiny or two or more sizes smaller than it.", "Escape: take an action to make a Strength (Athletics) or Dexterity (Acrobatics) check against the grapple's escape DC (8 + the grappler's Strength modifier + its Proficiency Bonus). On a success the condition ends."] },
  Incapacitated: { summary: "No actions, no Concentration.", rules: ["You can't take any action, Bonus Action or Reaction.", "Your Concentration is broken.", "You can't speak.", "If you're Incapacitated when you roll Initiative, you have Disadvantage on the roll."] },
  Invisible: { summary: "Unseen: Advantage to hit, harder to hit.", rules: ["Surprise: if you're Invisible when you roll Initiative, you have Advantage on the roll.", "Concealed: you aren't affected by any effect that requires its target to be seen, unless the effect's creator can somehow see you. Anything you wear or carry is also concealed.", "Attack rolls against you have Disadvantage, and your attack rolls have Advantage. If a creature can somehow see you, you don't get these benefits against it."] },
  Paralyzed: { speedZero: true, summary: "Incapacitated; close hits are critical.", rules: ["You have the Incapacitated condition.", "Your Speed is 0 and can't increase.", "You automatically fail Strength and Dexterity saving throws.", "Attack rolls against you have Advantage.", "Any attack roll that hits you is a Critical Hit if the attacker is within 5 feet of you."] },
  Petrified: { speedZero: true, summary: "Turned to stone.", rules: ["You and any nonmagical objects you're wearing or carrying are turned into a solid inanimate substance (usually stone). Your weight increases tenfold and you stop aging.", "You have the Incapacitated condition, and your Speed is 0 and can't increase.", "Attack rolls against you have Advantage.", "You automatically fail Strength and Dexterity saving throws.", "You have Resistance to all damage and Immunity to the Poisoned condition."] },
  Poisoned: { summary: "Disadvantage on attacks and checks.", rules: ["You have Disadvantage on attack rolls and ability checks."] },
  Prone: { summary: "Crawl or stand up; close attacks have Advantage.", rules: ["Your only movement options are to crawl or to spend an amount of movement equal to half your Speed (round down) to stand up and end the condition. If your Speed is 0, you can't stand up.", "You have Disadvantage on attack rolls.", "An attack roll against you has Advantage if the attacker is within 5 feet of you. Otherwise, it has Disadvantage."] },
  Restrained: { speedZero: true, summary: "Speed 0; easier to hit.", rules: ["Your Speed is 0 and can't increase.", "Attack rolls against you have Advantage, and your attack rolls have Disadvantage.", "You have Disadvantage on Dexterity saving throws."] },
  Stunned: { summary: "Incapacitated; fail Str and Dex saves.", rules: ["You have the Incapacitated condition.", "You automatically fail Strength and Dexterity saving throws.", "Attack rolls against you have Advantage."] },
  Unconscious: { speedZero: true, summary: "Out cold: Incapacitated and Prone.", rules: ["You have the Incapacitated and Prone conditions, and you drop whatever you're holding. When this condition ends, you remain Prone.", "Your Speed is 0 and can't increase.", "Attack rolls against you have Advantage.", "You automatically fail Strength and Dexterity saving throws.", "Any attack roll that hits you is a Critical Hit if the attacker is within 5 feet of you.", "You're unaware of your surroundings."] },
};
export const CONDITION_NAMES = Object.keys(CONDITIONS).sort((a, b) => a.localeCompare(b));

// ---------- weapons and Weapon Mastery (2024) ----------
// name -> [simple|martial, melee|ranged, mastery property, finesse, light]
const W = (cat, range, mastery, finesse = false, light = false) => ({ category: cat, range, mastery, finesse, light });
export const WEAPONS = {
  Club: W("simple", "melee", "Slow", false, true), Dagger: W("simple", "melee", "Nick", true, true), Greatclub: W("simple", "melee", "Push"),
  Handaxe: W("simple", "melee", "Vex", false, true), Javelin: W("simple", "melee", "Slow"), "Light Hammer": W("simple", "melee", "Nick", false, true),
  Mace: W("simple", "melee", "Sap"), Quarterstaff: W("simple", "melee", "Topple"), Sickle: W("simple", "melee", "Nick", false, true), Spear: W("simple", "melee", "Sap"),
  Dart: W("simple", "ranged", "Vex", true), "Light Crossbow": W("simple", "ranged", "Slow"), Shortbow: W("simple", "ranged", "Vex"), Sling: W("simple", "ranged", "Slow"),
  Battleaxe: W("martial", "melee", "Topple"), Flail: W("martial", "melee", "Sap"), Glaive: W("martial", "melee", "Graze"), Greataxe: W("martial", "melee", "Cleave"),
  Greatsword: W("martial", "melee", "Graze"), Halberd: W("martial", "melee", "Cleave"), Lance: W("martial", "melee", "Topple"), Longsword: W("martial", "melee", "Sap"),
  Maul: W("martial", "melee", "Topple"), Morningstar: W("martial", "melee", "Sap"), Pike: W("martial", "melee", "Push"), Rapier: W("martial", "melee", "Vex", true),
  Scimitar: W("martial", "melee", "Nick", true, true), Shortsword: W("martial", "melee", "Vex", true, true), Trident: W("martial", "melee", "Topple"),
  Warhammer: W("martial", "melee", "Push"), "War Pick": W("martial", "melee", "Sap"), Whip: W("martial", "melee", "Slow", true),
  Blowgun: W("martial", "ranged", "Vex"), "Hand Crossbow": W("martial", "ranged", "Vex", false, true), "Heavy Crossbow": W("martial", "ranged", "Push"),
  Longbow: W("martial", "ranged", "Slow"), Musket: W("martial", "ranged", "Slow"), Pistol: W("martial", "ranged", "Vex"),
};

// What each mastery property does, in short.
export const MASTERY = {
  Cleave: "Once per turn, when you hit with a melee attack, you can attack a second creature within 5 feet of the first and within your reach. On a hit it takes the weapon's damage, without your ability modifier unless that's negative.",
  Graze: "When your attack misses a creature, it still takes damage equal to the ability modifier you used for the attack, of the weapon's damage type.",
  Nick: "The extra attack from the Light property can be part of the Attack action instead of a Bonus Action, once per turn.",
  Push: "When you hit a Large or smaller creature, you can push it up to 10 feet straight away from you.",
  Sap: "When you hit a creature, it has Disadvantage on its next attack roll before the start of your next turn.",
  Slow: "When you hit and deal damage, you can reduce the creature's Speed by 10 feet until the start of your next turn (no more than 10 feet from several hits).",
  Topple: "When you hit a creature, you can make it succeed on a Constitution save (DC 8 + the attack's ability modifier + your Proficiency Bonus) or fall Prone.",
  Vex: "When you hit and deal damage, you have Advantage on your next attack roll against that creature before the end of your next turn.",
};

// Is a weapon covered by these proficiency entries? ("Simple", "Martial", "Martial (Finesse or Light)", "Longsword"...)
export function weaponProficient(name, profs) {
  const w = WEAPONS[name];
  if (!w) return false;
  return profs.some(p => {
    const t = String(p).toLowerCase();
    if (t === "simple" || t === "simple weapons") return w.category === "simple";
    if (t === "martial" || t === "martial weapons") return w.category === "martial";
    const m = t.match(/^martial \((.+)\)$/); // Martial (Finesse or Light), Martial (Light)
    if (m) return w.category === "martial" && ((/finesse/.test(m[1]) && w.finesse) || (/light/.test(m[1]) && w.light) || (/ranged/.test(m[1]) && w.range === "ranged") || (/melee/.test(m[1]) && w.range === "melee"));
    if (t === "martial ranged") return w.category === "martial" && w.range === "ranged";
    if (t === "martial melee") return w.category === "martial" && w.range === "melee";
    return t === name.toLowerCase() || t === `${name.toLowerCase()}s`;
  });
}
