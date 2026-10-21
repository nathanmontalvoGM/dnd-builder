// Spell effects turned on during play: Bless, Mage Armor, Shield, Haste...
// A spell note's dnd block describes what the spell does to the character it's on:
//   effect:
//     on: self | any        self: only the caster (Shield); any: you, or someone casts it on you (Bless)
//     summary: text          what the sheet can't track itself (Haste's extra action), shown on the chip
//     conditions: [Invisible]  conditions the effect gives while it's on
//     grants: [ ... ]        the same grants a magic item has
//     options:               instead of grants, when the caster picks a version
//       - { name: Fire, grants: [ ... ], summary, conditions }
import { describeGrant } from "./items.js";

export const hasEffect = spell => !!spell?.effect;
export const effectOptions = spell => spell?.effect?.options ?? null;
export const selfOnly = spell => spell?.effect?.on === "self";
const option = (spell, i) => (i != null ? spell?.effect?.options?.[i] ?? null : null);

// The entry the engine walks: a name for sources, and the grants of the chosen version.
export function effectEntry(spell, opt = null) {
  if (!spell?.effect) return null;
  const o = option(spell, opt);
  return { name: effectName(spell, opt), grants: (o ? o.grants : spell.effect.grants) ?? [] };
}
export const effectName = (spell, opt = null) => {
  const o = option(spell, opt);
  return o ? `${spell.name} (${o.name})` : spell?.name ?? "Effect";
};
export const effectConditions = (spell, opt = null) => [...(spell?.effect?.conditions ?? []), ...(option(spell, opt)?.conditions ?? [])];

// What it does, as short lines: "+1d4 to attack rolls", "AC can't be lower than 17".
export function describeEffect(spell, opt = null) {
  const e = spell?.effect;
  if (!e) return [];
  const o = option(spell, opt);
  const lines = ((o ? o.grants : e.grants) ?? []).map(describeGrant).filter(Boolean);
  const conds = effectConditions(spell, opt);
  if (conds.length) lines.unshift(`${conds.join(" and ")}${conds.length > 1 ? " conditions" : " condition"}`);
  for (const s of [o?.summary, e.summary]) if (s) lines.push(s);
  return lines;
}

// Rests end most effects. A long rest ends anything under a day; a short rest (an hour) ends
// anything that lasts an hour or less. 24 hours, days and "until dispelled" outlast both.
const minutes = d => {
  const t = String(d ?? "").toLowerCase();
  if (/until dispelled|special|permanent/.test(t)) return Infinity;
  const m = t.match(/(\d+)\s*(round|minute|hour|day)/);
  if (!m) return 0; // Instantaneous
  return Number(m[1]) * { round: 0.1, minute: 1, hour: 60, day: 1440 }[m[2]];
};
export const endsOnRest = (spell, kind) => minutes(spell?.duration) <= (kind === "long" ? 8 * 60 : 60);
