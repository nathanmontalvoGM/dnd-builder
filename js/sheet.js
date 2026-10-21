// The character sheet. Everything it shows is computed from the character file's own
// snapshot of the content, so content-pack updates never change a finished character.
// Only `play` (HP, used slots, gear, notes) changes here; the build is read-only.
import { summarize, resolve, normalizeBuild, mergeContent, snapshotFor, titleCase } from "./engine.js";
import { esc, md } from "./render.js";
import { itemLine, describeItemEffects, needsAttunement, customEntry, EFFECTS, effectDef, newEffect, DAMAGE_TYPES, SKILL_NAMES,
  ITEM_TYPES, RARITIES, rarityRank, EFFECT_KINDS, itemEffectKinds, itemPrice, canAttune } from "./items.js";
import { hasEffect, effectOptions, selfOnly, effectEntry, effectName, effectConditions, describeEffect, endsOnRest } from "./effects.js";
import { ABILITIES, ABBR, ABILITY_KEYS, SKILLS, signed, ordinal, CONDITIONS, CONDITION_NAMES } from "./rules.js";

const OPEN_KEY = "character-builder:sheet";
const COINS = ["cp", "sp", "ep", "gp", "pp"];

let state = null; // { file, dirty }
let loadedPack = null; // the content pack in this browser, for "update content"
export function setSheetPack(pack) { loadedPack = pack; }
let root = null;
const ui = { open: new Set(), closedGroups: new Set(), printing: false, layout: false, itemDraft: null, condPicker: false, condOpen: null, itemPicker: false, itemFilter: null, fxPicker: null, fxOpen: null, concCheck: null }; // expanded rows, collapsed groups, Edit layout mode, custom item being edited

// ---------- loading / persistence ----------
export function validateCharacter(data) {
  if (!data || data.kind !== "character") return "This isn't a character file.";
  if (data.format > 2) return "This character was saved by a newer version of the builder. Refresh the page and try again.";
  if (!data.build || !data.snapshot) return "This character file is missing its build or content snapshot.";
  return null;
}

function persist() {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify(state)); } catch {}
}

export function restoreCharacter() {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s?.file && !validateCharacter(s.file)) { state = s; state.file = upgradeFile(state.file); ensurePlay(); }
    }
  } catch {}
  return state?.file ?? null;
}

// Format 1 files have one class; format 2 has a classes list and hit dice spent per die size.
function upgradeFile(file) {
  if ((file.format ?? 1) >= 2) return file;
  const f = structuredClone(file);
  const oldClass = f.build?.class;
  f.build = normalizeBuild(f.build ?? {});
  const spent = f.play?.hitDiceSpent;
  if (typeof spent === "number") {
    const die = f.snapshot?.classes?.[oldClass]?.hit_die ?? 8;
    f.play.hitDiceSpent = spent ? { [die]: spent } : {};
  }
  f.format = 2;
  return f;
}

export function openCharacter(file, { dirty = false } = {}) {
  state = { file: upgradeFile(structuredClone(file)), dirty };
  ensurePlay();
  persist();
}

export function currentCharacter() { return state?.file ?? null; }
export function hasUnsavedChanges() { return !!state?.dirty; }

export function closeCharacter() {
  state = null;
  try { localStorage.removeItem(OPEN_KEY); } catch {}
}

const snapshotPack = file => ({ meta: { version: file.pack?.version }, ...file.snapshot });

// Magic items live in play.items: { uid, ref (a content-pack item id) or custom, equipped, attuned }.
// Pack items are copied into snapshot.items so the sheet works without the pack.
const itemEntry = (file, it) => (it.custom ? customEntry(it.custom, it.uid) : file.snapshot?.items?.[it.ref] ?? null);
const itemActive = (file, it) => !!it.equipped && (!needsAttunement(itemEntry(file, it)) || !!it.attuned);
const activeItems = file => (file.play?.items ?? []).filter(it => itemActive(file, it)).map(it => ({ key: it.uid, entry: itemEntry(file, it) })).filter(x => x.entry);
const newUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Spell effects live in play.effects: { uid, spell (a spell id), option (index of the chosen version, or
// null), mine (this character cast it, so it holds their Concentration) }. play.states are the `while:`
// states switched on ("Raging"). Spells used are copied into snapshot.spells like any other.
const spellEntry = (file, id) => file.snapshot?.spells?.[id] ?? loadedPack?.spells?.[id] ?? null;
const activeEffects = file => (file.play?.effects ?? []).map(x => ({ key: x.uid, entry: effectEntry(spellEntry(file, x.spell), x.option) })).filter(x => x.entry);
const concentrating = file => (file.play?.effects ?? []).filter(x => x.mine && spellEntry(file, x.spell)?.concentration);

function summaryFor(file) {
  const pack = snapshotPack(file);
  return summarize(file.build, pack, resolve(file.build, pack, { items: activeItems(file), effects: activeEffects(file), states: file.play?.states ?? [] }));
}
const computed = () => summaryFor(state.file);

function ensurePlay() {
  const s = computed();
  const p = (state.file.play ??= {});
  p.hp ??= { current: s.hp ?? 0, temp: 0 };
  if (typeof p.hitDiceSpent !== "object" || p.hitDiceSpent === null) p.hitDiceSpent = {};
  p.deathSaves ??= { success: 0, fail: 0 };
  p.inspiration ??= false;
  p.exhaustion ??= 0;
  p.slotsUsed ??= {};
  p.pactUsed ??= 0;
  p.resourcesUsed ??= {};
  p.featureUses ??= {};
  p.freeCastUsed ??= {};
  p.ac ??= null;
  p.armor ??= "none";      // none | light | medium | heavy
  p.shield ??= false;
  p.acMethod ??= null;     // name of the chosen AC calculation, null = best
  p.attacks ??= [];
  p.equipment ??= startingEquipmentText();
  p.coins ??= { cp: 0, sp: 0, ep: 0, gp: s.gold ?? 0, pp: 0 };
  p.notes ??= "";
  p.characterNotes ??= "";
  p.hidden ??= [];        // ids of sheet elements hidden with Edit layout
  p.items ??= [];         // magic items
  p.conditions ??= [];    // condition names, e.g. ["Prone", "Poisoned"]
  p.effects ??= [];       // spell effects on the character (Bless, Mage Armor)
  p.states ??= [];        // while: states switched on (Raging)
}

function startingEquipmentText() {
  const f = state.file;
  const lines = [];
  const cls = f.snapshot.classes?.[f.build.classes?.[0]?.id]; // only the starting class gives equipment
  const bg = f.snapshot.backgrounds?.[f.build.background];
  for (const [entry, pick] of [[cls, f.build.equipment?.class], [bg, f.build.equipment?.background]]) {
    const opt = (entry?.starting_equipment ?? []).find(o => o.label === pick);
    if (opt?.items) lines.push(...opt.items.split(/,\s*/));
  }
  return lines.join("\n");
}

function change(fn, { rerender = true } = {}) {
  fn(state.file.play, state.file);
  state.dirty = true;
  persist();
  if (rerender) render();
  else updateSaveState();
}

// ---------- mount ----------
export function mountSheet(el) {
  root = el;
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  root.addEventListener("keydown", onKey);
  render();
}
export function unmountSheet() {
  if (!root) return;
  root.removeEventListener("click", onClick);
  root.removeEventListener("change", onChange);
  root.removeEventListener("input", onInput);
  root.removeEventListener("keydown", onKey);
  root = null;
}

window.addEventListener("beforeunload", e => {
  if (state?.dirty) { e.preventDefault(); e.returnValue = ""; }
});

// ---------- small pieces ----------
function pips(count, used, attrs, label) {
  if (!count) return "";
  return `<span class="pips" role="group" aria-label="${esc(label)}: ${count - used} of ${count} left">${Array.from({ length: count }, (_, i) =>
    `<button type="button" class="pip ${i < used ? "used" : ""}" ${attrs} data-i="${i}" aria-label="${esc(label)} ${i + 1}${i < used ? ", used" : ""}"></button>`).join("")}</span>`;
}

// Which group a feature belongs in: one per class (its subclass features included), then species,
// background and feats.
function featureGroup(f, snapshot) {
  const k = f.key ?? "";
  if (k.includes(">feat.")) return "feats";
  if (k.startsWith("species.")) return "species";
  if (k.startsWith("background.")) return "background";
  if (k.startsWith("item.")) return "items";
  if (k.startsWith("effect.")) return null; // spell effects show in the Effects bar instead
  const m = k.match(/^(class|subclass)\.([^/>]+)/);
  if (!m) return "other";
  return `class:${m[1] === "class" ? m[2] : snapshot.subclasses?.[m[2]]?.class ?? m[2]}`;
}

const rechargeLabel = r => ({ short: "short rest", long: "long rest", dawn: "dawn" })[r] ?? r;

// Small line icons for the header buttons; they take the button's text color.
const icon = d => `<svg class="btn-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  levelup: icon('<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>'),
  edit: icon('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>'),
  layout: icon('<rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="15" width="7" height="5" rx="1"/><path d="M14 17.5h7"/>'),
  pdf: icon('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
  short: icon('<circle cx="12" cy="13" r="7"/><path d="M12 9v4l2.5 2"/><path d="M9 3h6"/>'),
  long: icon('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  save: icon('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/>'),
};

// ---------- hiding (Edit layout) ----------
// Every hideable element has a stable id kept in play.hidden. In the normal view (and the PDF) a hidden
// element isn't rendered at all; in Edit layout mode it's shown dimmed with a Show button.
const editing = () => ui.layout && !ui.printing;
const isHidden = id => !!state.file.play.hidden?.includes(id);
const shown = id => editing() || !isHidden(id);
function hideBtn(id, label) {
  if (!editing()) return "";
  const h = isHidden(id);
  return `<button type="button" class="hide-btn ${h ? "is-off" : ""}" data-hide="${esc(id)}" aria-pressed="${h}" aria-label="${h ? "Show" : "Hide"} ${esc(label)}">${h ? "Show" : "Hide"}</button>`;
}
// Wrap a box, panel, group or row so it can be hidden.
function hz(id, label, cls, inner, tag = "div") {
  if (!shown(id)) return "";
  return `<${tag} class="${cls} hideable${isHidden(id) ? " is-hidden" : ""}" data-hz="${esc(id)}">${hideBtn(id, label)}${inner}</${tag}>`;
}

// ---------- render ----------
function render() {
  if (!root || !state) return;
  const focusId = document.activeElement?.dataset?.focus;
  const pickerScroll = root.querySelector(".ip-results")?.scrollTop;
  const f = state.file;
  const s = computed();
  const p = f.play;
  const b = f.build;
  const classText = s.classes.map(c => `${c.name}${s.classes.length > 1 ? ` ${c.level}` : ""}${c.subclassName ? ` (${c.subclassName})` : ""}`).join(" / ");
  const species = f.snapshot.species?.[b.species];
  const bg = f.snapshot.backgrounds?.[b.background];
  const exh = p.exhaustion ?? 0;
  const armorState = armorView(s, p);
  // Conditions: the ones added by hand plus any an effect gives (Invisibility makes you Invisible).
  const condFrom = {};
  for (const x of p.effects ?? []) for (const c of effectConditions(spellEntry(f, x.spell), x.option)) if (CONDITIONS[c] && !p.conditions.includes(c)) condFrom[c] ??= effectName(spellEntry(f, x.spell), x.option);
  const conds = [...new Set([...(p.conditions ?? []), ...Object.keys(condFrom)])].filter(c => CONDITIONS[c]).sort((a, b) => a.localeCompare(b));
  const stoppedBy = conds.filter(c => CONDITIONS[c].speedZero);
  const speed = stoppedBy.length ? 0 : Math.max(0, armorState.speed - 5 * exh);
  const ac = p.ac ?? armorState.ac;
  const hpMax = s.hp ?? 0;

  const statStrip = [
    hz("stat:ac", "Armor class", "stat-box ac-box", `
        <label for="ac-input">Armor class</label>
        <input id="ac-input" type="number" data-play="ac" data-focus="ac" value="${ac ?? ""}" placeholder="?" min="0" max="40">
        <small>${p.ac != null ? `<button type="button" class="link-btn" data-ac-reset>${armorState.ac == null ? "clear" : `reset to ${armorState.ac}`}</button>` : armorState.ac == null ? "enter armor AC" : esc(armorState.label)}</small>`),
    hz("stat:initiative", "Initiative", "stat-box", `<span class="label">Initiative</span><strong>${signed(s.initiative - 2 * exh)}${diceTag(s.initiativeDice)}</strong>${s.initiativeAdvantage.length ? `<small>${advBadge(s.initiativeAdvantage)} Advantage</small>` : ""}`),
    hz("stat:speed", "Speed", "stat-box", `<span class="label">Speed</span><strong>${speed} ft</strong>${stoppedBy.length ? `<small>${esc(stoppedBy.join(", "))}</small>` : `${s.speedMult !== 1 ? `<small>${s.speedMult === 2 ? "Doubled" : s.speedMult === 0.5 ? "Halved" : `×${s.speedMult}`} by an effect</small>` : ""}${armorState.speedLost ? `<small>−${armorState.speedLost} ${armorState.why}</small>` : ""}${exh ? `<small>−${5 * exh} from exhaustion</small>` : ""}`}`),
    hz("stat:proficiency", "Proficiency", "stat-box", `<span class="label">Proficiency</span><strong>${signed(s.pb)}</strong>`),
    hz("stat:perception", "Passive Perception", "stat-box", `<span class="label">Passive Perception</span><strong>${s.passivePerception}</strong>`),
    hz("stat:size", "Size", "stat-box", `<span class="label">Size</span><strong class="small-value">${esc(s.size ?? "Medium")}</strong>${s.darkvision ? `<small>Darkvision ${s.darkvision} ft</small>` : ""}`),
    hz("stat:hp", "Hit points", "hp-box", `
        <div class="hp-numbers">
          <label class="hp-current"><span class="label">Hit points</span>
            <input type="number" data-play="hp.current" data-focus="hp" value="${p.hp.current}" min="0" max="${hpMax}"><span class="hp-max">/ ${hpMax}</span></label>
          <label class="hp-temp"><span class="label">Temporary</span><input type="number" data-play="hp.temp" data-focus="temp" value="${p.hp.temp}" min="0"></label>
        </div>
        ${hz("stat:inspiration", "Heroic Inspiration", "insp", `<button type="button" class="insp-toggle${p.inspiration ? " on" : ""}" data-inspiration aria-pressed="${p.inspiration}"><span class="insp-dot" aria-hidden="true"></span>Heroic Inspiration</button>`)}
        <div class="hp-adjust">
          <input type="number" min="0" placeholder="Amount" data-hp-amount data-focus="hp-amount" aria-label="Damage or healing amount">
          <button type="button" class="btn" data-hp="damage">Damage</button>
          <button type="button" class="btn" data-hp="heal">Heal</button>
        </div>
        <div class="hp-bar" aria-hidden="true" data-state="${hpMax && p.hp.current <= hpMax / 4 ? "low" : hpMax && p.hp.current <= hpMax / 2 ? "bloodied" : "ok"}"><span style="width:${hpMax ? Math.min(100, (p.hp.current / hpMax) * 100) : 0}%"></span></div>`),
    hz("stat:hitdice", "Hit dice", "stat-box tracker-box", `
        <span class="label">Hit dice</span>
        ${s.hitDice.map(h => { const used = Math.min(h.count, p.hitDiceSpent[h.die] ?? 0); return `<span class="stepper${s.hitDice.length > 1 ? " hd-row" : ""}"><span class="muted">d${h.die}</span>
          <button type="button" class="step-btn" data-hd="1" data-die="${h.die}" ${used >= h.count ? "disabled" : ""} aria-label="Spend a d${h.die} hit die">−</button>
          <strong>${h.count - used}</strong><span class="muted">/ ${h.count}</span>
          <button type="button" class="step-btn" data-hd="-1" data-die="${h.die}" ${used <= 0 ? "disabled" : ""} aria-label="Regain a d${h.die} hit die">+</button></span>`; }).join("")}`),
    hz("stat:death", "Death saves", "stat-box tracker-box", `
        <span class="label">Death saves</span>
        <span class="death"><span>Success</span>${pips(3, p.deathSaves.success, 'data-death="success"', "Death save success")}</span>
        <span class="death"><span>Fail</span>${pips(3, p.deathSaves.fail, 'data-death="fail"', "Death save failure")}</span>`),
    hz("stat:exhaustion", "Exhaustion", "stat-box tracker-box", `
        <span class="label">Exhaustion</span>
        <span class="stepper"><button type="button" class="step-btn" data-exh="-1" ${exh <= 0 ? "disabled" : ""} aria-label="Remove a level of exhaustion">−</button>
          <strong>${exh}</strong>
          <button type="button" class="step-btn" data-exh="1" ${exh >= 6 ? "disabled" : ""} aria-label="Add a level of exhaustion">+</button></span>
        ${exh >= 6 ? `<small class="exh-dead">Level 6: the character dies</small>` : exh ? `<small>−${2 * exh} to d20 tests, −${5 * exh} ft Speed</small>` : ""}`),
    hz("stat:armor", "Armor and AC", "stat-box armor-box", `
        <span class="label">Armor and AC</span>
        <div class="armor-controls">
          ${armorState.armorItem ? `<span class="armor-item">Armor: <strong>${esc(armorState.armorItem.name)}</strong></span>`
            : `<label>Armor <select data-armor aria-label="Armor worn">${["none", "light", "medium", "heavy"].map(a => `<option value="${a}" ${p.armor === a ? "selected" : ""}>${a === "none" ? "None" : titleCase(a)}</option>`).join("")}</select></label>`}
          ${armorState.shieldItem ? `<span class="armor-item">Shield: <strong>${esc(armorState.shieldItem.name)}</strong></span>`
            : `<label class="check"><input type="checkbox" data-shield ${p.shield ? "checked" : ""}> Shield</label>`}
        </div>
        ${armorState.options.length > 1 ? `<label class="ac-from">AC from <select data-ac-method aria-label="How AC is calculated">${armorState.options.map(o => `<option value="${esc(o.name)}" ${o.name === armorState.method ? "selected" : ""}>${esc(o.name)} (${o.value + armorState.shieldAc + armorState.bonus})</option>`).join("")}</select></label>` : ""}
        ${armorState.note ? `<small>${esc(armorState.note)}</small>` : ""}`),
  ].join("");

  const abilities = ABILITY_KEYS.map(a => {
    const save = s.saves.find(x => x.ability === a);
    const skills = s.skills.filter(k => k.ability === a);
    return hz(`ability:${a}`, ABILITIES[a], "ability-block", `
      <div class="ability-top"><h3>${ABILITIES[a]}</h3><span class="ability-mod">${signed(s.mods[a])}</span><span class="ability-score">${s.scores[a]}</span></div>
      <ul>
        <li class="${save.prof ? "prof" : ""}"><span class="dot" aria-label="${save.prof ? "proficient" : "not proficient"}"></span>Saving throw${advBadge(save.advantage)}<span class="val">${signed(save.bonus)}${diceTag(save.dice)}</span></li>
        ${skills.map(k => `<li class="${k.prof ? "prof" : ""} ${k.expertise ? "expert" : ""}"><span class="dot" aria-label="${k.expertise ? "expertise" : k.prof ? "proficient" : "not proficient"}"></span>${esc(k.name)}${advBadge(k.advantage)}<span class="val">${signed(k.bonus)}${diceTag(k.dice)}</span></li>`).join("")}
      </ul>`);
  }).join("");

  const mainCol = [
    renderAttacks(s, p),
    renderClassStats(s),
    hz("panel:yournotes", "Your notes", "panel", `<h2><label for="char-notes">Your notes</label></h2>
      ${box(`<textarea id="char-notes" rows="14" data-play="characterNotes" data-focus="char-notes" placeholder="Reminders, combos, tactics, anything you want handy during play">${esc(p.characterNotes)}</textarea>`, p.characterNotes)}`, "section"),
  ].join("");

  // Limited uses sit at the top of the right-hand column; the long features list gets its own
  // full-width row under the columns so it doesn't stretch one column far past the others.
  const sideCol = [
    renderResources(s, p),
    hz("panel:training", "Training", "panel", `<h2>Training</h2>
      <dl class="facts compact one-col">
        <div><dt>Armor</dt><dd>${esc(uniq(s.proficiencies.armor).join(", ") || "None")}</dd></div>
        <div><dt>Weapons</dt><dd>${esc(uniq(s.proficiencies.weapon).join(", ") || "None")}</dd></div>
        <div><dt>Tools</dt><dd>${esc(uniq(s.proficiencies.tool).join(", ") || "None")}</dd></div>
        <div><dt>Languages</dt><dd>${esc(uniq(s.proficiencies.language).join(", "))}</dd></div>
      </dl>`, "section"),
    renderDefenses(s),
    // Magic items sit at the top of Equipment, with the rest of the gear and coins under them.
    hz("panel:equipment", "Equipment", "panel equipment-panel", `<h2>Equipment</h2>
      ${renderItems(s, p, f)}
      <div class="equip-sub"><h3><label for="equip">Gear</label></h3></div>
      ${box(`<textarea id="equip" rows="10" data-play="equipment" data-focus="equipment" placeholder="One item per line">${esc(p.equipment)}</textarea>`, p.equipment)}
      <div class="coins">${COINS.map(c => `<label><span>${c.toUpperCase()}</span><input type="number" min="0" data-play="coins.${c}" data-focus="coin-${c}" value="${p.coins[c] ?? 0}"></label>`).join("")}</div>`, "section"),
  ].join("");

  const gridCls = ["sheet-grid", abilities.trim() && "has-abil", mainCol.trim() && "has-main", sideCol.trim() && "has-side"].filter(Boolean).join(" ");
  const hiddenCount = (p.hidden ?? []).length;

  root.innerHTML = `
  <article class="sheet${editing() ? " layout-mode" : ""}">
    <header class="sheet-head">
      <div class="sheet-id">
        <h1>${esc(f.details?.name || "Unnamed character")}</h1>
        <p class="id-line">${esc([`Level ${s.level} ${classText}`, species?.name, bg?.name, f.details?.alignment].filter(Boolean).join(", "))}</p>
        <div class="id-level" aria-hidden="true"><span>Level</span><strong>${s.level}</strong></div>
        <dl class="id-fields">
          <div class="id-class"><dt>Class</dt><dd>${esc(classText)}</dd></div>
          ${species?.name ? `<div><dt>Species</dt><dd>${esc(species.name)}</dd></div>` : ""}
          ${bg?.name ? `<div><dt>Background</dt><dd>${esc(bg.name)}</dd></div>` : ""}
          ${f.details?.alignment ? `<div><dt>Alignment</dt><dd>${esc(f.details.alignment)}</dd></div>` : ""}
        </dl>
        ${editing() ? "" : `<div class="sheet-tools" role="toolbar" aria-label="Character tools">
          <button type="button" class="tool-btn" data-levelup ${s.level >= 20 ? "disabled" : ""}>${ICONS.levelup}Level up</button>
          <button type="button" class="tool-btn" data-edit-build>${ICONS.edit}Edit in builder</button>
          <button type="button" class="tool-btn" data-layout aria-pressed="false">${ICONS.layout}Edit layout</button>
          <button type="button" class="tool-btn" data-print>${ICONS.pdf}Export PDF</button>
        </div>`}
      </div>
      <div class="sheet-actions">
        ${editing() ? `<button type="button" class="btn btn-primary" data-layout aria-pressed="true">Done editing layout</button>` : `
        <div class="rest-group" role="group" aria-label="Rest">
          <button type="button" class="btn" data-rest="short">${ICONS.short}Short rest</button>
          <button type="button" class="btn" data-rest="long">${ICONS.long}Long rest</button>
        </div>
        <button type="button" class="btn btn-primary save-btn" data-save>${ICONS.save}${state.dirty ? "Save file" : "Saved"}</button>
        <button type="button" class="btn btn-quiet" data-close>Close</button>`}
      </div>
    </header>
    ${editing() ? `<div class="layout-banner" role="status">
      <p><strong>Editing layout.</strong> Hide anything you don't need during play: whole panels, groups, single features, spells or boxes. Hidden items are dimmed here and left out of the sheet and the PDF. Your layout is saved in the character file.</p>
      ${hiddenCount ? `<button type="button" class="btn" data-show-all>Show everything (${hiddenCount} hidden)</button>` : ""}
    </div>` : ""}
    ${loadedPack && loadedPack.meta?.version !== f.pack?.version ? `<div class="update-note">
      <p>Built with content pack ${esc(f.pack?.version ?? "unknown")}. The pack loaded here is ${esc(loadedPack.meta?.version)}.</p>
      <button type="button" class="btn" data-refresh-content>Update this character's content</button>
    </div>` : ""}

    ${statStrip ? `<section class="combat-strip" aria-label="Combat">${statStrip}</section>` : ""}
    ${renderConditions(conds, condFrom)}
    ${renderEffects(s, p, f)}

    <div class="${gridCls}">
      ${abilities.trim() ? `<section class="abilities-col" aria-label="Abilities and skills">${abilities}</section>` : ""}
      ${mainCol.trim() ? `<div class="main-col">${mainCol}</div>` : ""}
      ${sideCol.trim() ? `<aside class="side-col">${sideCol}</aside>` : ""}
    </div>

    ${renderFeatures(s, p, f)}

    ${renderSpells(s, p, f)}
    ${ui.condPicker && !ui.printing ? renderConditionPicker(conds) : ""}
    ${ui.itemPicker && !ui.printing ? renderItemPicker(s, p, f) : ""}
    ${ui.fxPicker && !ui.printing ? renderEffectPicker(s, p, f) : ""}

    ${hz("panel:notes", "Notes", "panel notes-panel", `
      <h2>Notes</h2>
      <div class="notes-grid">
        <label class="field"><span>Session notes</span>${box(`<textarea rows="6" data-play="notes" data-focus="notes">${esc(p.notes)}</textarea>`, p.notes)}</label>
        <label class="field"><span>Appearance and backstory</span>${box(`<textarea rows="6" data-detail="backstory" data-focus="backstory">${esc(f.details?.backstory ?? "")}</textarea>`, f.details?.backstory)}</label>
      </div>`, "section")}
    <p class="sheet-foot muted">${!ui.layout && !ui.printing && hiddenCount ? `${hiddenCount} item${hiddenCount === 1 ? " is" : "s are"} hidden. <button type="button" class="link-btn" data-layout>Edit layout</button> to bring ${hiddenCount === 1 ? "it" : "them"} back. ` : ""}Built with content pack ${esc(f.pack?.version ?? "unknown")}. Last saved ${f.updated ? new Date(f.updated).toLocaleString() : "never"}.</p>
  </article>`;

  if (ui.itemPicker && !ui.printing) setupItemPicker(pickerScroll);
  if (ui.fxPicker && !ui.printing) filterEffects();
  if (focusId) {
    const el = root.querySelector(`[data-focus="${CSS.escape(focusId)}"]`);
    if (el) el.focus({ preventScroll: !!ui.itemPicker });
  }
}

// ---------- PDF export ----------
// The browser's print dialog does the PDF ("Save as PDF"). For the printout every feature and spell is
// expanded, collapsed groups open, and text boxes become plain text so nothing is cut off.
const box = (html, text) => ui.printing ? `<div class="print-text">${esc(text ?? "") || "&nbsp;"}</div>` : html;

function exportPdf(s) {
  const f = state.file;
  const title = document.title;
  const name = f.details?.name || "Character";
  document.title = `${name} - Level ${s.level} ${s.classes.map(c => c.name).join(" ")}`.replace(/[\\/:*?"<>|]+/g, "");
  ui.printing = true;
  document.documentElement.classList.add("printing");
  render();
  const done = () => {
    ui.printing = false;
    document.documentElement.classList.remove("printing");
    document.title = title;
    render();
  };
  window.addEventListener("afterprint", done, { once: true });
  // Give fonts a moment, then open the dialog.
  (document.fonts?.ready ?? Promise.resolve()).then(() => window.print());
}

// ---------- content updates ----------
// Re-read the class, species, feat and spell entries this character uses from the loaded pack.
// Choices stay as they are. If max HP changes, current HP moves by the same amount.
function refreshContent(before) {
  if (!loadedPack || !confirm("Update this character's rules text and numbers from the loaded content pack? Your choices stay the same. Save the file afterward to keep it.")) return;
  const f = state.file;
  const merged = mergeContent(loadedPack, f.snapshot);
  // Every pack item the character has (equipped or not) stays in the snapshot, with its spells.
  const refs = [...new Set((f.play.items ?? []).filter(it => !it.custom && it.ref).map(it => it.ref))];
  const res = resolve(f.build, merged, { items: refs.map(id => ({ key: id, entry: merged.items?.[id] })).filter(x => x.entry) });
  change((p, file) => {
    file.snapshot = snapshotFor(res, merged);
    file.snapshot.items = Object.fromEntries(refs.filter(id => merged.items?.[id]).map(id => [id, merged.items[id]]));
    file.pack = { version: loadedPack.meta?.version, built: loadedPack.meta?.built };
    const after = summaryFor(file);
    const delta = (after.hp ?? 0) - (before.hp ?? 0);
    p.hp.current = Math.max(0, Math.min(after.hp ?? 0, p.hp.current + delta));
  });
}

// ---------- armor, AC and conditional speed ----------
// Which AC calculations apply with the armor and shield toggles, which one is used, and the
// speed bonuses that switch off in armor (Unarmored Movement) or heavy armor (Fast Movement).
function armorView(s, p) {
  // Armor or a shield from an equipped magic item takes over from the manual toggles.
  const armorItem = (s.armorItems ?? []).find(a => a.type !== "shield");
  const shieldItem = (s.armorItems ?? []).find(a => a.type === "shield");
  const armorType = armorItem?.type ?? p.armor ?? "none";
  const armored = armorType !== "none";
  const shield = !!shieldItem || !!p.shield;
  const fails = req => ({
    no_armor: armored, no_heavy_armor: armorType === "heavy", no_shield: shield, unarmored: armored || shield,
  })[req] ?? false;
  const shieldAc = shield ? 2 + (shieldItem?.bonus ?? 0) : 0;
  const bonuses = (s.acBonuses ?? []).filter(b => !b.requires || !fails(b.requires));
  const bonus = bonuses.reduce((n, b) => n + (b.value ?? 0), 0);
  const options = armored ? [] : s.acOptions.filter(o => o.armor === "none" && (!shield || o.shield));
  const best = options.slice().sort((a, b) => b.value - a.value)[0];
  const chosen = options.find(o => o.name === p.acMethod) ?? best;
  let base = null, baseName = "";
  if (armorItem) {
    const dex = s.mods.dex;
    base = armorItem.ac + (armorType === "light" ? dex : armorType === "medium" ? Math.min(dex, 2) : 0) + (armorItem.bonus ?? 0);
    baseName = armorItem.name;
  } else if (chosen) { base = chosen.value; baseName = chosen.name; }
  let ac = base != null ? base + shieldAc + bonus : null;
  // "AC can't be lower than 17" (Barkskin): a floor, not a bonus.
  const floor = s.acMin && ac != null && ac < s.acMin.value ? s.acMin : null;
  if (floor) ac = floor.value;
  const speedLost = (s.conditionalStats ?? []).filter(c => c.stat === "speed" && fails(c.requires)).reduce((n, c) => n + (c.value ?? 0), 0);
  const lostAc = armored ? [] : s.acOptions.filter(o => o.armor === "none" && !options.includes(o) && o.source !== "Core rules").map(o => o.name);
  const bonusNames = bonuses.map(b => b.source);
  const note = armored && !armorItem ? `Your armor sets your AC; type it in the box${bonus ? ` (add ${signed(bonus)} from ${bonusNames.join(", ")})` : ""}.`
    : lostAc.length ? `${lostAc.join(", ")} doesn't work with a shield.` : "";
  const why = armored ? "in armor" : "with a shield";
  const label = floor ? `${floor.source} (at least ${floor.value})` : base != null ? [baseName, shield ? (shieldItem?.name ?? "shield") : null, ...bonusNames].filter(Boolean).join(" + ") : "";
  return { why, options, method: chosen?.name ?? null, ac, label, speed: s.speed - speedLost, speedLost, note, armorItem, shieldItem, armorType, shield, shieldAc, bonus };
}

// Advantage marker for a save, skill or initiative. Conditional ones get an asterisk and a tooltip.
function advBadge(list) {
  if (!list?.length) return "";
  const always = list.some(a => !a.note);
  const tip = list.map(a => `${a.source}${a.note ? `: ${a.note}` : ""}`).join("; ");
  return ` <span class="adv ${always ? "" : "adv-cond"}" title="Advantage (${esc(tip)})">Adv${always ? "" : "*"}</span>`;
}

// Numbers a feature carries (save DC, damage, its table column), shown on its row.
function featureChips(f) {
  const bits = [...(f.die ? [f.die] : []), ...(f.stats ?? []).map(st => `${st.label} ${st.value}`)];
  return bits.length ? ` <span class="chips">${bits.map(b => `<span class="chip-sm">${esc(b)}</span>`).join("")}</span>` : "";
}
function featureBody(f) {
  const facts = [...(f.die ? [["Die", f.die]] : []), ...(f.stats ?? []).map(st => [st.label, st.value])];
  return `${facts.length ? `<dl class="facts compact feature-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}${f.while ? `<div><dt>Applies</dt><dd>while ${esc(f.while)}</dd></div>` : ""}</dl>` : ""}${md(f.text)}`;
}

// Every number features carry, in one place: Martial Arts die, save DCs, Rage damage and so on.
function renderClassStats(s) {
  const rows = new Map();
  for (const f of s.features) {
    for (const st of f.stats ?? []) {
      const k = `${st.label}|${st.value}`;
      if (!rows.has(k)) rows.set(k, { label: st.label, value: st.value, from: [] });
      rows.get(k).from.push(f.name);
    }
    if (f.die) { const k = `die|${f.name}`; rows.set(k, { label: `${f.name} die`, value: f.die, from: [f.name] }); }
  }
  if (!rows.size) return "";
  return hz("panel:glance", "At a glance", "panel", `<h2>At a glance</h2><dl class="facts compact glance">${[...rows.values()].map(r =>
    `<div><dt>${esc(r.label)}</dt><dd>${esc(r.value)}${r.from.length && !(r.from.length === 1 && r.label.startsWith(r.from[0])) ? ` <span class="muted">${esc(r.from.join(", "))}</span>` : ""}</dd></div>`).join("")}</dl>`, "section");
}

// Resistances and the advantages that only apply in some situations.
function renderDefenses(s) {
  const res = s.resistances ?? [];
  const adv = (s.advantages ?? []).filter(a => a.vs || a.while || a.on === "check");
  if (!res.length && !adv.length) return "";
  const what = a => a.on === "save" ? `${a.abilities ? a.abilities.map(x => ABBR[x]).join(", ") + " saves" : "Saves"}${a.vs ? ` against ${a.vs}` : ""}`
    : a.on === "check" ? `${a.abilities ? a.abilities.map(x => ABBR[x]).join(", ") + " checks" : "Checks"}${a.vs ? ` for ${a.vs}` : ""}`
    : a.on === "initiative" ? "Initiative" : "Attacks";
  return hz("panel:defenses", "Defenses", "panel", `<h2>Defenses</h2><dl class="facts compact one-col">
    ${res.map(r => `<div><dt>Resistance${r.while ? ` while ${esc(r.while)}` : ""}</dt><dd>${esc(r.damage.join(", "))} <span class="muted">${esc(r.source)}</span></dd></div>`).join("")}
    ${adv.map(a => `<div><dt>Advantage${a.while ? ` while ${esc(a.while)}` : ""}</dt><dd>${esc(what(a))} <span class="muted">${esc(a.source)}</span></dd></div>`).join("")}
  </dl>`, "section");
}

const uniq = arr => [...new Set(arr.map(x => x.value ?? x))];

function renderAttacks(s, p) {
  const u = s.unarmed;
  return hz("panel:attacks", "Weapons and attacks", "panel", `<h2>Weapons and attacks</h2>
    <table class="attack-table computed"><tbody><tr>
      <th scope="row">${esc(u.name)}</th><td>${signed(u.attack)}${diceTag(u.attackDice)}</td><td>${esc([`${u.damage} ${u.type}`, ...(u.extraDice ?? [])].join(" + "))}</td>
      <td class="muted">${esc([u.source !== "Core rules" ? `${u.source}, ${ABILITIES[u.ability]}` : ABILITIES[u.ability], ...u.notes].join("; "))}</td>
    </tr>${(s.weaponAttacks ?? []).map(w => `<tr class="item-attack">
      <th scope="row">${esc(w.name)}</th><td>${signed(w.attack)}${diceTag(w.attackDice)}</td><td>${esc(w.damage)}</td>
      <td class="muted">${esc([ABILITIES[w.ability], w.properties].filter(Boolean).join("; "))}</td>
    </tr>`).join("")}</tbody></table>
    ${p.attacks.length ? `<table class="attack-table">
      <thead><tr><th scope="col">Name</th><th scope="col">Attack</th><th scope="col">Damage</th><th scope="col">Notes</th><th><span class="visually-hidden">Remove</span></th></tr></thead>
      <tbody>${p.attacks.map((a, i) => `<tr>
        <td><input type="text" data-attack="${i}" data-field="name" data-focus="atk-${i}-name" value="${esc(a.name)}" aria-label="Attack name"></td>
        <td><input type="text" data-attack="${i}" data-field="bonus" data-focus="atk-${i}-bonus" value="${esc(a.bonus)}" aria-label="Attack bonus" class="narrow"></td>
        <td><input type="text" data-attack="${i}" data-field="damage" data-focus="atk-${i}-damage" value="${esc(a.damage)}" aria-label="Damage"></td>
        <td><input type="text" data-attack="${i}" data-field="notes" data-focus="atk-${i}-notes" value="${esc(a.notes)}" aria-label="Notes"></td>
        <td><button type="button" class="link-btn" data-remove-attack="${i}" aria-label="Remove ${esc(a.name || "attack")}">Remove</button></td>
      </tr>`).join("")}</tbody></table>` : `<p class="muted attack-hint">Add your weapons here. Attack bonus is your Strength or Dexterity modifier plus your proficiency bonus if you're trained with it.</p>`}
    ${attackEffectNote(s)}
    <button type="button" class="btn" data-add-attack>Add an attack</button>`, "section");
}

function renderResources(s, p) {
  const withUses = s.features.filter(f => f.uses?.max);
  if (!s.resources.length && !withUses.length) return "";
  const rows = [
    ...s.resources.map(r => {
      const used = Math.min(p.resourcesUsed[r.id] ?? 0, r.max ?? 0);
      return hz(`res:${r.id}`, r.name, "res-row", `<span class="res-name">${esc(r.name)}</span>${pips(r.max ?? 0, used, `data-resource="${esc(r.id)}"`, r.name)}
        <span class="muted res-note">${esc(`${r.max - used} left. All back on a ${rechargeLabel(r.recharge)}${r.short_rest_regain ? `, ${r.short_rest_regain} back on a short rest` : ""}`)}</span>`, "li");
    }),
    ...withUses.map(f => {
      const used = Math.min(p.featureUses[f.key] ?? 0, f.uses.max);
      return hz(`use:${f.key}`, f.name, "res-row", `<span class="res-name">${esc(f.name)}</span>${pips(f.uses.max, used, `data-feature-use="${esc(f.key)}"`, f.name)}
        <span class="muted res-note">Back on a ${esc(rechargeLabel(f.uses.recharge))}</span>`, "li");
    }),
  ].join("");
  return hz("panel:resources", "Limited uses", "panel", `<h2>Limited uses</h2>
    ${rows ? `<ul class="resource-list">${rows}</ul>` : `<p class="muted">Everything here is hidden.</p>`}`, "section");
}

// ---------- conditions ----------
// A bar of the conditions the character has. Clicking one shows what it does; "Add condition"
// opens a window with every condition in alphabetical order.
function renderConditions(conds, from = {}) {
  return hz("stat:conditions", "Conditions", "conditions-bar", `
    <span class="label">Conditions</span>
    <span class="cond-list">${conds.map(c => {
      const open = ui.condOpen === c && !ui.printing;
      return `<span class="cond-wrap"><button type="button" class="cond-chip${open ? " open" : ""}" data-cond-info="${esc(c)}" aria-expanded="${open}">${esc(c)}</button>${open ? `
        <div class="cond-pop" role="dialog" aria-label="${esc(c)}">
          <strong>${esc(c)}</strong>
          <ul>${CONDITIONS[c].rules.map(r => `<li>${esc(r)}</li>`).join("")}</ul>
          ${from[c] ? `<p class="muted">From ${esc(from[c])}. It goes when that effect ends.</p>` : `<button type="button" class="link-btn" data-cond-remove="${esc(c)}">Remove ${esc(c)}</button>`}
        </div>` : ""}</span>`;
    }).join("") || `<span class="muted cond-none">None</span>`}</span>
    <button type="button" class="btn cond-add" data-cond-add>Add condition</button>`, "section");
}

function renderConditionPicker(conds) {
  const has = new Set(conds);
  return `<div class="cond-back" data-cond-back>
    <div class="cond-modal" role="dialog" aria-modal="true" aria-labelledby="cond-title">
      <h2 id="cond-title">Add a condition</h2>
      <p class="muted">Click a condition to add it; click it again to take it off.</p>
      <div class="cond-grid">${CONDITION_NAMES.map(n => `<button type="button" class="cond-option${has.has(n) ? " on" : ""}" data-cond-toggle="${esc(n)}" aria-pressed="${has.has(n)}">
        <strong>${esc(n)}</strong><span>${esc(CONDITIONS[n].summary)}</span></button>`).join("")}</div>
      <p class="muted cond-note">Exhaustion has its own tracker in the boxes above.</p>
      <div class="cond-foot"><button type="button" class="btn btn-primary" data-cond-close>Done</button></div>
    </div>
  </div>`;
}

// ---------- effects ----------
// "+1d4" after a number, for Bless, Bane, Guidance.
const diceTag = list => (list?.length ? `<span class="dice-bonus">${esc(list.join(""))}</span>` : "");

// A bar under Conditions: toggles for states like Rage, then the spell effects on the character.
// Clicking an effect shows what it does; "Add effect" opens a window of every spell that has one.
function renderEffects(s, p, f) {
  const toggles = s.toggles ?? [];
  const conc = concentrating(f);
  const chips = (p.effects ?? []).map(x => {
    const sp = spellEntry(f, x.spell);
    const name = effectName(sp, x.option);
    const open = ui.fxOpen === x.uid && !ui.printing;
    const isConc = x.mine && sp?.concentration;
    return `<span class="cond-wrap"><button type="button" class="cond-chip fx-chip${open ? " open" : ""}${isConc ? " conc" : ""}" data-fx-info="${esc(x.uid)}" aria-expanded="${open}">${esc(name)}${isConc ? `<span class="conc-mark" title="You're concentrating on this">C</span>` : ""}</button>${open ? `
      <div class="cond-pop" role="dialog" aria-label="${esc(name)}">
        <strong>${esc(name)}</strong>
        <ul>${describeEffect(sp, x.option).map(l => `<li>${esc(l)}</li>`).join("") || "<li>Nothing on the sheet changes.</li>"}</ul>
        <p class="muted">${esc([sp?.duration ? `Lasts ${String(sp.duration).replace(/^up to/i, "up to")}` : "", isConc ? "You're concentrating on it" : x.mine ? "You cast it" : "Cast on you by someone else"].filter(Boolean).join(". "))}.</p>
        <button type="button" class="link-btn" data-fx-remove="${esc(x.uid)}">End ${esc(sp?.name ?? "effect")}</button>
      </div>` : ""}</span>`;
  });
  const states = toggles.map(t => `<button type="button" class="fx-toggle${t.on ? " on" : ""}" data-state-toggle="${esc(t.state)}" aria-pressed="${t.on}" title="${esc(t.on ? `End ${t.name}` : `Start ${t.name}`)}"><span class="insp-dot" aria-hidden="true"></span>${esc(t.name)}</button>`);
  const check = ui.concCheck && !ui.printing ? `<div class="conc-check" role="alert">
      <span>${esc(ui.concCheck.text)}</span>
      ${ui.concCheck.dc ? `<button type="button" class="btn" data-conc="keep">Made it</button><button type="button" class="btn" data-conc="lose">Failed</button>` : `<button type="button" class="btn" data-conc="ok">OK</button>`}
    </div>` : "";
  if (ui.printing && !chips.length && !toggles.some(t => t.on)) return "";
  return hz("stat:effects", "Effects", "conditions-bar effects-bar", `
    <span class="label">Effects</span>
    <span class="cond-list">${states.join("")}${chips.join("") || (states.length ? "" : `<span class="muted cond-none">None</span>`)}</span>
    ${conc.length && !ui.printing ? `<span class="muted conc-note">Concentrating on ${esc(conc.map(x => spellEntry(f, x.spell)?.name).join(", "))}</span>` : ""}
    <button type="button" class="btn cond-add" data-fx-add>Add effect</button>
    ${check}`, "section");
}

// Effects that change attacks, listed under the attack table (typed-in attacks don't pick them up).
function attackEffectNote(s) {
  const lines = (s.bonusList ?? []).filter(b => ["attack_rolls", "attack", "damage"].includes(b.to) && (state.file.play.effects ?? []).length && activeEffects(state.file).some(x => x.entry.name === b.source))
    .map(b => `${b.source}: ${b.dice ? `${/^[+-]/.test(b.dice) ? b.dice.replace(/^-/, "−") : `+${b.dice}`}` : signed(b.value)}${b.to === "damage" ? ` ${b.damage_type ?? ""} damage` : " to hit"}${b.note ? ` ${b.note}` : ""}`.replace(/\s+/g, " "));
  if (!lines.length) return "";
  return `<p class="muted fx-attack-note">${esc(lines.join(" · "))}. Rows you typed in don't include these.</p>`;
}

const ownSpellIds = s => new Set((s.spells ?? []).map(x => x.id));

function renderEffectPicker(s, p, f) {
  const F = ui.fxPicker;
  const pool = { ...(loadedPack?.spells ?? {}), ...(f.snapshot.spells ?? {}) };
  const mine = ownSpellIds(s);
  const list = Object.entries(pool).filter(([, sp]) => hasEffect(sp)).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const active = new Set((p.effects ?? []).map(x => `${x.spell}|${x.option ?? ""}`));
  const row = ([id, sp]) => {
    const opts = effectOptions(sp);
    const lines = describeEffect(sp, opts ? 0 : null);
    const tags = [sp.level === 0 ? "Cantrip" : `Level ${sp.level}`, sp.concentration ? "Concentration" : null, selfOnly(sp) ? "Caster only" : null, sp.duration].filter(Boolean);
    const add = (i, label) => {
      const on = active.has(`${id}|${i ?? ""}`);
      return `<button type="button" class="btn fx-add-btn${on ? " is-on" : ""}" data-fx-pick="${esc(id)}"${i != null ? ` data-fx-opt="${i}"` : ""} ${on ? "disabled" : ""}>${on ? "On" : esc(label)}</button>`;
    };
    return `<li class="fx-row" data-q="${esc(searchText(`${sp.name} ${lines.join(" ")} ${(opts ?? []).map(o => o.name).join(" ")}`))}">
      <div class="fx-row-head"><strong>${esc(sp.name)}</strong><span class="muted">${esc(tags.join(" · "))}</span></div>
      <p class="fx-lines">${esc(opts ? `Pick a version. ${opts[0].name}: ${describeEffect(sp, 0).join(" · ")}` : lines.join(" · ") || "Nothing on the sheet changes.")}</p>
      <div class="fx-actions">${!opts ? add(null, "Add")
        : opts.length <= 6 ? opts.map((o, i) => add(i, o.name)).join("")
        : `<select data-fx-select="${esc(id)}" aria-label="${esc(sp.name)} version">${opts.map((o, i) => `<option value="${i}"${active.has(`${id}|${i}`) ? " disabled" : ""}>${esc(o.name)}${active.has(`${id}|${i}`) ? " (on)" : ""}</option>`).join("")}</select>
           <button type="button" class="btn fx-add-btn" data-fx-pick="${esc(id)}" data-fx-from-select>Add</button>`}</div>
    </li>`;
  };
  const yours = list.filter(([id]) => mine.has(id));
  const others = list.filter(([id, sp]) => !mine.has(id) && !selfOnly(sp));
  return `<div class="cond-back fx-back" data-fx-back>
    <div class="cond-modal fx-modal" role="dialog" aria-modal="true" aria-labelledby="fx-title">
      <h2 id="fx-title">Add an effect</h2>
      <input type="search" class="ip-search" data-fx-q data-focus="fx-q" value="${esc(F.q)}" placeholder="Search ${list.length} spells with effects…" aria-label="Search spell effects" autocomplete="off" spellcheck="false">
      <label class="check fx-others"><input type="checkbox" data-fx-others${F.others ? " checked" : ""}> Someone else cast it on me <span class="muted">(it won't count as your Concentration)</span></label>
      <div class="fx-results">
        ${yours.length ? `<h3 class="fx-group">Your spells</h3><ul class="fx-list">${yours.map(row).join("")}</ul>` : ""}
        ${others.length ? `<h3 class="fx-group">Cast on you by someone else</h3><ul class="fx-list">${others.map(row).join("")}</ul>` : ""}
        <p class="ip-none fx-none" hidden>No spell effects match.</p>
      </div>
      <div class="cond-foot ip-foot"><span class="ip-added muted" aria-live="polite">${F.added ? `Added ${esc(F.added)}.` : ""}</span><button type="button" class="btn btn-primary" data-fx-close>Done</button></div>
    </div>
  </div>`;
}

function filterEffects() {
  const modal = root.querySelector(".fx-modal");
  if (!modal) return;
  const words = searchText(ui.fxPicker.q).split(" ").filter(Boolean);
  let n = 0;
  for (const li of modal.querySelectorAll(".fx-row")) {
    const ok = words.every(w => li.dataset.q.includes(` ${w}`));
    li.hidden = !ok;
    if (ok) n++;
  }
  for (const h of modal.querySelectorAll(".fx-group")) h.hidden = ![...h.nextElementSibling.children].some(li => !li.hidden);
  modal.querySelector(".fx-none").hidden = n > 0;
}

// Turn an effect on. `mine`: this character cast it, so a second Concentration spell of theirs
// replaces the first.
function addEffect(id, option, mine) {
  const f = state.file;
  const sp = spellEntry(f, id);
  if (!sp?.effect) return false;
  const nowConc = mine && sp.concentration ? concentrating(f) : [];
  if (nowConc.length && !confirm(`You're concentrating on ${nowConc.map(x => spellEntry(f, x.spell)?.name).join(", ")}. Casting ${sp.name} ends ${nowConc.length > 1 ? "them" : "it"}. Go ahead?`)) return false;
  itemChange((p, file) => {
    if (loadedPack?.spells?.[id] && !file.snapshot.spells?.[id]) (file.snapshot.spells ??= {})[id] = loadedPack.spells[id];
    const drop = new Set(nowConc.map(x => x.uid));
    p.effects = p.effects.filter(x => !drop.has(x.uid) && !(x.spell === id && (x.option ?? null) === (option ?? null)));
    p.effects.push({ uid: newUid(), spell: id, option: option ?? null, mine: !!mine });
  });
  return true;
}
const removeEffects = pred => itemChange(p => { p.effects = p.effects.filter(x => !pred(x)); });

// Switching a state on uses one of its uses when it has them (entering a Rage spends a Rage).
function toggleState(state_, s) {
  const t = (s.toggles ?? []).find(x => x.state === state_);
  if (!t) return;
  itemChange(p => {
    if (p.states.includes(state_)) { p.states = p.states.filter(x => x !== state_); return; }
    const feat = s.features.find(x => x.key === t.key);
    const res = s.resources.find(r => r.name.toLowerCase() === t.name.toLowerCase());
    const left = feat?.uses?.max ? feat.uses.max - (p.featureUses[feat.key] ?? 0) : res ? (res.max ?? 0) - (p.resourcesUsed[res.id] ?? 0) : 1;
    if (left <= 0 && !confirm(`No ${t.name} uses left. Turn it on anyway?`)) return;
    p.states = [...p.states, state_];
    if (feat?.uses?.max) p.featureUses[feat.key] = Math.min(feat.uses.max, (p.featureUses[feat.key] ?? 0) + 1);
    else if (res) p.resourcesUsed[res.id] = Math.min(res.max ?? 0, (p.resourcesUsed[res.id] ?? 0) + 1);
  });
}

// ---------- the magic item picker ----------
// A window over the whole pack: search at the top, quick type and rarity filters, and an Advanced
// section (attunement, what it does on the sheet, source, price, sort). It's drawn from ui.itemFilter
// once; typing and filtering then show and hide rows in place, so the search box keeps its focus.
const newItemFilter = () => ({ q: "", types: [], rarities: [], attune: "any", mine: false, effects: [], rules: false, source: "", maxPrice: "", inText: false, sort: "name", open: [], added: null });
const searchText = s => ` ${String(s).toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9+]+/g, " ").trim()}`;
const SOURCE_NAMES = { DMG24: "Dungeon Master's Guide (2024)", PHB24: "Player's Handbook (2024)", MM25: "Monster Manual (2025)", EFA: "Eberron: Forge of the Artificer",
  FRHoF: "Forgotten Realms: Heroes of Faerûn", FRAiF: "Forgotten Realms: Adventures in Faerûn" };
let textIndex = { pack: null, map: new Map() }; // item id -> its description, for "search descriptions too"
function itemTextIndex() {
  if (textIndex.pack !== loadedPack) textIndex = { pack: loadedPack, map: new Map(Object.entries(loadedPack?.items ?? {}).map(([id, e]) => [id, searchText(`${e.text ?? ""} ${e.base_item ?? ""}`)])) };
  return textIndex.map;
}
const pressed = (on) => `aria-pressed="${on}"`;
const clip = (text, n) => text.length > n ? `${text.slice(0, n).replace(/[\s,·]+\S*$/, "")} …` : text;

function renderItemPicker(s, p, f) {
  const F = ui.itemFilter ??= newItemFilter();
  const entries = Object.entries(loadedPack?.items ?? {}).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const owned = new Set((p.items ?? []).map(i => i.ref).filter(Boolean));
  const classNames = s.classes.map(c => c.name);
  const speciesName = f.snapshot.species?.[f.build.species]?.name ?? "";
  const isCaster = !!s.spellcasting;
  const typesHere = ITEM_TYPES.filter(([k]) => entries.some(([, e]) => e.item_type === k));
  const raritiesHere = RARITIES.filter(([k]) => entries.some(([, e]) => (e.rarity ?? "varies") === k));
  const sources = [...new Set(entries.map(([, e]) => e.source).filter(Boolean))].sort((a, b) => (SOURCE_NAMES[a] ?? a).localeCompare(SOURCE_NAMES[b] ?? b));
  const advCount = advancedCount(F);
  const rows = entries.map(([id, e]) => {
    const fx = itemEffectKinds(e);
    const effects = describeItemEffects(e);
    const price = itemPrice(e);
    return `<li class="ip-row" data-id="${esc(id)}" data-type="${esc(e.item_type ?? "")}" data-rarity="${esc(e.rarity ?? "varies")}" data-rank="${rarityRank(e.rarity)}"
        data-att="${e.attunement ? 1 : 0}" data-mine="${canAttune(e, classNames, speciesName, isCaster) ? 1 : 0}" data-fx=" ${fx.join(" ")} " data-src="${esc(e.source ?? "")}"
        data-price="${price ?? ""}" data-q="${esc(searchText(`${e.name} ${itemLine(e)} ${effects.join(" ")}`))}">
      <div class="ip-line">
        <button type="button" class="ip-name" data-ip-preview="${esc(id)}" aria-expanded="false">
          <strong>${esc(e.name)}</strong>
          <span>${esc(itemLine(e))}${e.price && price != null ? ` · ${esc(String(e.price).replace(/^B\+/, "base + "))}` : ""}</span>
          ${effects.length ? `<small>${esc(clip(effects.join(" · "), 110))}</small>` : ""}
        </button>
        ${owned.has(id) ? `<span class="ip-owned">On sheet</span>` : ""}
        <button type="button" class="btn ip-add" data-item-add="${esc(id)}" data-focus="ip-add:${esc(id)}" aria-label="Add ${esc(e.name)}">Add</button>
      </div>
      <div class="ip-detail" hidden></div>
    </li>`;
  }).join("");
  const chip = (attr, key, label, on) => `<button type="button" class="ip-chip" ${attr}="${esc(key)}" ${pressed(on)}>${esc(label)}</button>`;
  return `<div class="cond-back ip-back" data-ip-back>
    <div class="cond-modal ip-modal" role="dialog" aria-modal="true" aria-labelledby="ip-title">
      <h2 id="ip-title">Add a magic item</h2>
      <div class="ip-controls">
        <input type="search" class="ip-search" data-ip-q data-focus="ip-q" value="${esc(F.q)}" placeholder="Search ${entries.length} magic items by name, type or effect…" aria-label="Search magic items" autocomplete="off" spellcheck="false">
        <div class="ip-filter-row" role="group" aria-label="Type"><span class="ip-label">Type</span>${typesHere.map(([k, l]) => chip("data-ip-type", k, l, F.types.includes(k))).join("")}</div>
        <div class="ip-filter-row" role="group" aria-label="Rarity"><span class="ip-label">Rarity</span>${raritiesHere.map(([k, l]) => chip("data-ip-rarity", k, l, F.rarities.includes(k))).join("")}</div>
        <details class="ip-advanced"${advCount ? " open" : ""}>
          <summary>Advanced filters<span class="ip-adv-count"${advCount ? "" : " hidden"}>${advCount}</span></summary>
          <div class="ip-adv-grid">
            <label class="ip-field"><span>Attunement</span><select data-ip-attune>
              ${[["any", "Any"], ["no", "No attunement needed"], ["yes", "Requires attunement"]].map(([k, l]) => `<option value="${k}"${F.attune === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
            <label class="ip-field"><span>Source</span><select data-ip-source><option value="">Any book</option>
              ${sources.map(x => `<option value="${esc(x)}"${F.source === x ? " selected" : ""}>${esc(SOURCE_NAMES[x] ?? x)}</option>`).join("")}</select></label>
            <label class="ip-field"><span>Most it can cost (GP)</span><input type="number" min="0" step="50" data-ip-price value="${esc(F.maxPrice)}" placeholder="No limit"></label>
            <label class="ip-field"><span>Sort by</span><select data-ip-sort>
              ${[["name", "Name"], ["rarity", "Rarity, common first"], ["rarity-desc", "Rarity, rarest first"], ["price", "Price, cheapest first"]].map(([k, l]) => `<option value="${k}"${F.sort === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
            <div class="ip-field ip-wide" role="group" aria-label="What it does on the sheet"><span>What it does on the sheet <small>(any of these)</small></span>
              <div class="ip-chips">${EFFECT_KINDS.map(([k, l]) => chip("data-ip-fx", k, l, F.effects.includes(k))).join("")}</div></div>
            <div class="ip-checks ip-wide">
              <label class="check"><input type="checkbox" data-ip-mine${F.mine ? " checked" : ""}> Only items ${esc(f.details?.name || s.classes[0]?.name || "this character")} can attune to</label>
              <label class="check"><input type="checkbox" data-ip-rules${F.rules ? " checked" : ""}> Only items that change the sheet</label>
              <label class="check"><input type="checkbox" data-ip-intext${F.inText ? " checked" : ""}> Search descriptions too</label>
            </div>
          </div>
        </details>
      </div>
      <div class="ip-status"><span data-ip-count aria-live="polite"></span><button type="button" class="link-btn" data-ip-reset>Clear filters</button></div>
      <ul class="ip-results">${rows}<li class="ip-none" hidden>No magic items match. Try fewer filters, or make a custom item.</li></ul>
      <div class="cond-foot ip-foot"><span class="ip-added muted" aria-live="polite">${F.added ? `Added ${esc(F.added)}.` : ""}</span><button type="button" class="btn btn-primary" data-ip-close>Done</button></div>
    </div>
  </div>`;
}

function advancedCount(F) {
  return (F.attune !== "any") + F.mine + F.rules + F.inText + (F.source !== "") + (F.maxPrice !== "") + (F.effects.length > 0) + (F.sort !== "name");
}

// Show the rows that pass every filter. `reorder` re-sorts the list too (on open and when Sort changes).
function applyItemFilter(reorder = false) {
  const modal = root.querySelector(".ip-modal");
  if (!modal) return;
  const F = ui.itemFilter;
  const words = searchText(F.q).split(" ").filter(Boolean);
  const max = F.maxPrice === "" ? null : Number(F.maxPrice);
  const texts = F.inText ? itemTextIndex() : null;
  const list = modal.querySelector(".ip-results");
  const rows = [...list.querySelectorAll(".ip-row")];
  let n = 0;
  for (const li of rows) {
    const d = li.dataset;
    const hay = d.q + (texts ? texts.get(d.id) ?? "" : "");
    const ok = (!F.types.length || F.types.includes(d.type))
      && (!F.rarities.length || F.rarities.includes(d.rarity))
      && (F.attune === "any" || (F.attune === "yes") === (d.att === "1"))
      && (!F.mine || d.mine === "1")
      && (!F.rules || d.fx.trim() !== "")
      && (!F.effects.length || F.effects.some(k => d.fx.includes(` ${k} `)))
      && (!F.source || d.src === F.source)
      && (max == null || (d.price !== "" && Number(d.price) <= max))
      && words.every(w => hay.includes(` ${w}`));
    li.hidden = !ok;
    if (ok) n++;
  }
  if (reorder) {
    const name = li => li.querySelector(".ip-name strong").textContent;
    const descRank = li => li.dataset.rarity === "varies" ? -1 : +li.dataset.rank; // "Rarity varies" sorts last either way
    const by = {
      name: (a, b) => name(a).localeCompare(name(b)),
      rarity: (a, b) => a.dataset.rank - b.dataset.rank || name(a).localeCompare(name(b)),
      "rarity-desc": (a, b) => descRank(b) - descRank(a) || name(a).localeCompare(name(b)),
      price: (a, b) => (a.dataset.price === "" ? Infinity : +a.dataset.price) - (b.dataset.price === "" ? Infinity : +b.dataset.price) || name(a).localeCompare(name(b)),
    }[F.sort] ?? (() => 0);
    list.prepend(...rows.sort(by));
  }
  modal.querySelector(".ip-none").hidden = n > 0;
  modal.querySelector("[data-ip-count]").textContent = n === rows.length ? `${n} magic items` : `${n} of ${rows.length} magic items`;
  const adv = advancedCount(F), badge = modal.querySelector(".ip-adv-count");
  badge.textContent = adv; badge.hidden = !adv;
}

function setupItemPicker(scroll) {
  applyItemFilter(true);
  for (const id of ui.itemFilter.open) previewItem(id, true);
  const list = root.querySelector(".ip-results");
  if (scroll != null && list) list.scrollTop = scroll;
}

function previewItem(id, open) {
  const li = root.querySelector(`.ip-row[data-id="${CSS.escape(id)}"]`);
  if (!li) return;
  const btn = li.querySelector(".ip-name"), box = li.querySelector(".ip-detail");
  const show = open ?? box.hidden;
  if (show && !box.innerHTML) {
    const e = loadedPack?.items?.[id];
    const effects = describeItemEffects(e);
    box.innerHTML = `${effects.length ? `<ul class="item-effects">${effects.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">Nothing on the sheet changes; the text is the rules.</p>`}
      ${md(String(e?.text ?? "").replace(/^\s*#{1,6}\s+.*\n+/, ""))}`;
  }
  box.hidden = !show;
  li.classList.toggle("open", show);
  btn.setAttribute("aria-expanded", show);
  const F = ui.itemFilter;
  F.open = show ? [...new Set([...F.open, id])] : F.open.filter(x => x !== id);
}

function closeEffectPicker() {
  ui.fxPicker = null;
  render();
  root.querySelector("[data-fx-add]")?.focus();
}

function closeItemPicker() {
  ui.itemPicker = false;
  if (ui.itemFilter) { ui.itemFilter.added = null; ui.itemFilter.open = []; }
  render();
  root.querySelector("[data-item-open]")?.focus();
}

// Clicks inside the picker. Returns true when handled.
function itemPickerClick(t) {
  const d = t.dataset, F = ui.itemFilter;
  const toggle = (list, key) => { const on = !list.includes(key); t.setAttribute("aria-pressed", on); return on ? [...list, key] : list.filter(x => x !== key); };
  if (d.ipType) { F.types = toggle(F.types, d.ipType); applyItemFilter(); return true; }
  if (d.ipRarity) { F.rarities = toggle(F.rarities, d.ipRarity); applyItemFilter(); return true; }
  if (d.ipFx) { F.effects = toggle(F.effects, d.ipFx); applyItemFilter(); return true; }
  if (d.ipPreview) { previewItem(d.ipPreview); return true; }
  if (d.ipReset !== undefined) { ui.itemFilter = newItemFilter(); render(); root.querySelector("[data-ip-q]")?.focus(); return true; }
  if (d.ipClose !== undefined) { closeItemPicker(); return true; }
  return false;
}

// Arrow keys move between the search box and the results' names; Escape clears the search, then closes.
function itemPickerKey(e) {
  const t = e.target;
  const names = () => [...root.querySelectorAll(".ip-row:not([hidden]) .ip-name")];
  if (e.key === "Escape") {
    e.preventDefault();
    if (t.matches("[data-ip-q]") && t.value) { t.value = ""; ui.itemFilter.q = ""; applyItemFilter(); }
    else closeItemPicker();
    return;
  }
  if (t.matches("[data-ip-q]") && (e.key === "ArrowDown" || e.key === "Enter")) { e.preventDefault(); names()[0]?.focus(); return; }
  if (t.matches(".ip-name") && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const list = names(), i = list.indexOf(t) + (e.key === "ArrowDown" ? 1 : -1);
    (i < 0 ? root.querySelector("[data-ip-q]") : list[Math.min(i, list.length - 1)])?.focus();
  }
}

function onKey(e) {
  if (ui.itemPicker) return itemPickerKey(e);
  if (ui.fxPicker && e.key === "Escape") {
    e.preventDefault();
    const q = e.target.matches?.("[data-fx-q]") ? e.target : null;
    if (q?.value) { q.value = ""; ui.fxPicker.q = ""; filterEffects(); } else closeEffectPicker();
    return;
  }
  if (ui.fxOpen && e.key === "Escape") { const u = ui.fxOpen; ui.fxOpen = null; render(); root.querySelector(`[data-fx-info="${CSS.escape(u)}"]`)?.focus(); return; }
  if (e.key !== "Escape") return;
  if (ui.condPicker) { ui.condPicker = false; render(); root.querySelector("[data-cond-add]")?.focus(); }
  else if (ui.condOpen) { const c = ui.condOpen; ui.condOpen = null; render(); root.querySelector(`[data-cond-info="${CSS.escape(c)}"]`)?.focus(); }
}

// ---------- magic items ----------
function renderItems(s, p, f) {
  const items = p.items ?? [];
  const attuned = items.filter(it => it.attuned && needsAttunement(itemEntry(f, it))).length;
  const anyAttune = items.some(it => needsAttunement(itemEntry(f, it)));
  const packItems = Object.entries(loadedPack?.items ?? {}).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const rows = items.map(it => {
    const e = itemEntry(f, it);
    const id = `item:${it.uid}`;
    if (!shown(`row:${id}`)) return "";
    const open = ui.printing || ui.open.has(id);
    const status = !e ? "Not in this character's content" : !it.equipped ? "Not equipped" : needsAttunement(e) && !it.attuned ? "Not attuned: no effect yet" : "";
    const effects = describeItemEffects(e);
    return `<li class="item-row hideable${open ? " open" : ""}${itemActive(f, it) ? "" : " inactive"}${isHidden(`row:${id}`) ? " is-hidden" : ""}">
      ${hideBtn(`row:${id}`, e?.name ?? "item")}
      <div class="item-line">
        <button type="button" class="feature-toggle" data-toggle="${esc(id)}" aria-expanded="${open}"><span>${esc(e?.name ?? "Missing item")}</span><span class="muted">${esc(status || itemLine(e))}</span></button>
        <span class="item-controls">
          <label class="check"><input type="checkbox" data-item-equip="${esc(it.uid)}" ${it.equipped ? "checked" : ""}> Equipped</label>
          ${needsAttunement(e) ? `<label class="check"><input type="checkbox" data-item-attune="${esc(it.uid)}" ${it.attuned ? "checked" : ""}> Attuned</label>` : ""}
        </span>
      </div>
      ${open ? `<div class="feature-body item-body">
        ${status ? `<p class="muted">${esc(itemLine(e))}</p>` : ""}
        ${effects.length ? `<ul class="item-effects">${effects.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${md(String(e?.text ?? "").replace(/^\s*#{1,6}\s+.*\n+/, ""))}
        ${ui.printing ? "" : `<p class="item-actions">${it.custom ? `<button type="button" class="link-btn" data-item-edit="${esc(it.uid)}">Edit</button> · ` : ""}<button type="button" class="link-btn" data-item-remove="${esc(it.uid)}">Remove</button></p>`}
      </div>` : ""}
    </li>`;
  }).join("");
  const add = ui.printing ? "" : `<div class="item-add">
      ${packItems.length ? `<button type="button" class="btn btn-primary" data-item-open data-focus="item-open">Add magic item</button>` : ""}
      <button type="button" class="btn" data-item-custom>Custom item</button>
    </div>
    ${!packItems.length && !items.length ? `<p class="muted">Load a content pack with items to pick from it, or make a custom item for DM loot.</p>` : ""}
    ${ui.itemDraft ? renderItemDraft() : ""}`;
  return hz("panel:items", "Magic items", "items-panel", `<div class="equip-sub"><h3>Magic items</h3>
      ${anyAttune ? `<span class="attune-count${attuned > 3 ? " over" : ""}" title="Most characters can attune to 3 items at once">Attuned ${attuned} / 3</span>` : ""}</div>
    ${rows ? `<ul class="item-list">${rows}</ul>` : items.length ? `<p class="muted">Everything here is hidden.</p>` : `<p class="muted">No magic items yet.</p>`}
    ${add}`);
}

// The custom item editor: name, attunement, text and a list of effects.
function renderItemDraft() {
  const d = ui.itemDraft;
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? "selected" : ""}>${esc(l)}</option>`).join("");
  const field = (i, fx, name) => {
    const at = `data-fx="${i}" data-fx-field="${name}"`;
    const lab = (text, control) => `<label class="fx-field"><span>${text}</span>${control}</label>`;
    switch (name) {
      case "value": {
        const word = { weapon: "Bonus", armor: "Bonus", charges: "How many", score_set: "Score", score_add: "Increase", speed: "Feet", darkvision: "Feet" }[fx.kind] ?? "Bonus";
        return lab(word, `<input type="number" ${at} data-focus="fx-${i}-value" value="${esc(fx.value)}">`);
      }
      case "ability": return lab("Ability", `<select ${at}>${opt([...(fx.kind === "saves" ? [["all", "All saves"]] : []), ...ABILITY_KEYS.map(a => [a, ABILITIES[a]])], fx.ability)}</select>`);
      case "skill": return lab("Skill", `<select ${at}>${opt(SKILL_NAMES.map(k => [k, k]), fx.skill)}</select>`);
      case "dtype": return lab("Damage type", `<select ${at}>${opt(DAMAGE_TYPES.map(t => [t, t]), fx.dtype)}</select>`);
      case "name": return lab("Name", `<input type="text" ${at} data-focus="fx-${i}-name" value="${esc(fx.name)}">`);
      case "dice": return lab("Damage dice", `<input type="text" ${at} data-focus="fx-${i}-dice" value="${esc(fx.dice)}" placeholder="1d8">`);
      case "wability": return lab("Uses", `<select ${at}>${opt([["str", "Strength"], ["dex", "Dexterity"], ["finesse", "Str or Dex (finesse)"]], fx.wability)}</select>`);
      case "atype": return lab("Type", `<select ${at}>${opt([["light", "Light armor"], ["medium", "Medium armor"], ["heavy", "Heavy armor"], ["shield", "Shield"]], fx.atype)}</select>`);
      case "base": return fx.atype === "shield" ? "" : lab("Base AC", `<input type="number" ${at} data-focus="fx-${i}-base" value="${esc(fx.base)}">`);
      default: return "";
    }
  };
  const rows = d.effects.map((fx, i) => `<div class="fx-row">
      <label class="fx-field"><span>Effect</span><select data-fx="${i}" data-fx-field="kind">${opt(EFFECTS.map(x => [x.kind, x.label]), fx.kind)}</select></label>
      ${effectDef(fx.kind).fields.map(n => field(i, fx, n)).join("")}
      <button type="button" class="link-btn" data-draft-remove-effect="${i}" aria-label="Remove this effect">Remove</button>
    </div>`).join("");
  return `<div class="item-draft" role="group" aria-label="Custom item">
    <h3>${d.uid ? "Edit custom item" : "New custom item"}</h3>
    <label class="fx-field wide"><span>Name</span><input type="text" data-draft="name" data-focus="draft-name" value="${esc(d.name)}" placeholder="Ring of Something"></label>
    <label class="check"><input type="checkbox" data-draft="attunement" ${d.attunement ? "checked" : ""}> Requires attunement</label>
    <label class="fx-field wide"><span>Description</span><textarea data-draft="text" data-focus="draft-text" rows="3" placeholder="What it does, for when you open it">${esc(d.text)}</textarea></label>
    <div class="fx-list">${rows || `<p class="muted">No effects yet: it will only show its description.</p>`}</div>
    <p><button type="button" class="btn" data-draft-add-effect>Add an effect</button></p>
    <div class="draft-actions"><button type="button" class="btn btn-primary" data-draft-save>Save item</button> <button type="button" class="btn btn-quiet" data-draft-cancel>Cancel</button></div>
  </div>`;
}

// Item changes can move max HP (Amulet of Health); current HP moves with it.
function itemChange(fn) {
  const before = computed().hp ?? 0;
  change((p, file) => {
    fn(p, file);
    const after = summaryFor(file).hp ?? 0;
    if (after !== before) p.hp.current = Math.max(0, Math.min(after, p.hp.current + (after - before)));
  });
}

function addPackItem(id) {
  const e = loadedPack?.items?.[id];
  if (!e) return;
  itemChange((p, file) => {
    file.snapshot.items = { ...(file.snapshot.items ?? {}), [id]: e };
    for (const g of e.grants ?? []) if (g.type === "spells") for (const sid of g.ids ?? []) if (loadedPack.spells?.[sid]) (file.snapshot.spells ??= {})[sid] = loadedPack.spells[sid];
    const attuned = p.items.filter(it => it.attuned).length;
    p.items.push({ uid: newUid(), ref: id, equipped: true, attuned: !!e.attunement && attuned < 3 });
  });
}

function saveDraft() {
  const d = ui.itemDraft;
  const custom = { name: String(d.name ?? "").trim() || "Custom item", text: d.text ?? "", attunement: !!d.attunement, effects: d.effects.map(fx => ({ ...fx })) };
  ui.itemDraft = null;
  itemChange(p => {
    const it = d.uid && p.items.find(x => x.uid === d.uid);
    if (it) it.custom = custom;
    else p.items.push({ uid: newUid(), custom, equipped: true, attuned: custom.attunement && p.items.filter(x => x.attuned).length < 3 });
  });
}

function renderFeatures(s, p, f) {
  // Groups in a fixed order: each class as taken, then species, background, feats.
  const groups = new Map();
  for (const c of s.classes) groups.set(`class:${c.id}`, { title: `${c.name} ${c.level}`, sub: c.subclassName, items: [] });
  groups.set("species", { title: `${f.snapshot.species?.[f.build.species]?.name ?? "Species"} traits`, items: [] });
  groups.set("background", { title: f.snapshot.backgrounds?.[f.build.background]?.name ?? "Background", items: [] });
  groups.set("feats", { title: "Feats", items: [] });
  groups.set("items", { title: "Magic items", items: [] });
  groups.set("other", { title: "Other", items: [] });
  for (const feat of s.features) {
    const g = featureGroup(feat, f.snapshot);
    if (g == null) continue;
    if (!groups.has(g)) groups.set(g, { title: titleCase(g.replace(/^class:/, "")), items: [] });
    groups.get(g).items.push(feat);
  }
  // Class features in level order, subclass features slotted in where they're gained.
  for (const [k, g] of groups) if (k.startsWith("class:")) g.items.sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
  const featEntries = s.feats.map(x => ({ ...x, entry: f.snapshot.feats?.[x.id] }));
  const featFeatureNames = new Set(featEntries.map(x => x.name));
  const row = (id, name, sourceText, body, chips = "") => {
    if (!shown(`row:${id}`)) return "";
    const open = ui.printing || ui.open.has(id);
    return `<li class="feature-row hideable ${open ? "open" : ""}${isHidden(`row:${id}`) ? " is-hidden" : ""}">
      ${hideBtn(`row:${id}`, name)}
      <button type="button" class="feature-toggle" data-toggle="${esc(id)}" aria-expanded="${open}"><span>${esc(name)}${chips}</span><span class="muted">${esc(sourceText)}</span></button>
      ${open ? `<div class="feature-body">${body || `<p class="muted">No description in the content snapshot.</p>`}</div>` : ""}
    </li>`;
  };
  const strip = t => String(t ?? "").replace(/^\s*#{1,6}\s+.*\n+/, "");
  // "Monk, level 5" reads as "Level 5" under a Monk heading; subclass features keep their subclass name.
  const where = (x, g) => {
    if (!g.startsWith("class:") || x.level == null) return x.source;
    const by = x.source.replace(/, level \d+$/, "");
    return `Level ${x.level}${by !== groups.get(g).title.replace(/ \d+$/, "") ? ` · ${by}` : ""}`;
  };
  const section = (key, title, sub, count, body) => {
    if (!shown(`group:${key}`) || !body.replace(/<\/?ul[^>]*>/g, "").trim()) return "";
    const closed = !ui.printing && ui.closedGroups.has(key);
    return `<div class="feature-group hideable ${closed ? "closed" : ""}${isHidden(`group:${key}`) ? " is-hidden" : ""}">
      ${hideBtn(`group:${key}`, title)}
      <button type="button" class="group-toggle" data-group="${esc(key)}" aria-expanded="${!closed}">
        <span class="group-title">${esc(title)}${sub ? ` <span class="group-sub">${esc(sub)}</span>` : ""}</span>
        <span class="muted">${count}</span></button>
      ${closed ? "" : body}
    </div>`;
  };
  // A group's rows split into two independent lists (first half, second half) that sit side by side
  // on a wide screen, so opening a feature only pushes down its own column.
  const rowLists = rows => {
    rows = rows.filter(Boolean);
    if (!rows.length) return "";
    const half = Math.ceil(rows.length / 2);
    return `<div class="feature-cols"><ul class="feature-rows">${rows.slice(0, half).join("")}</ul>${rows.length > 1 ? `<ul class="feature-rows">${rows.slice(half).join("")}</ul>` : ""}</div>`;
  };
  const out = [];
  for (const [key, g] of groups) {
    if (key === "feats") {
      const extra = g.items.filter(x => !featFeatureNames.has(x.name)); // a feat's own feature repeats the feat
      const n = featEntries.length + extra.length;
      if (!n) continue;
      out.push(section(key, g.title, null, n, rowLists([
        ...featEntries.map(x => row(`feat:${x.key}`, x.name, `from ${x.source}`, `${(() => { const ff = g.items.find(i => i.name === x.name); return ff ? featureBody({ ...ff, text: "" }) : ""; })()}${md(strip(x.entry?.text))}`, featureChips(g.items.find(i => i.name === x.name) ?? {}))),
        ...extra.map(x => row(`f:${x.key}`, x.name, x.source, featureBody(x), featureChips(x))),
      ])));
      continue;
    }
    if (!g.items.length) continue;
    out.push(section(key, g.title, g.sub, g.items.length, rowLists(g.items.map(x => row(`f:${x.key}`, x.name, where(x, key), featureBody(x), featureChips(x))))));
  }
  return hz("panel:features", "Features and traits", "panel features-panel", `<div class="panel-head"><h2>Features and traits</h2>
      <span class="panel-tools"><button type="button" class="link-btn" data-groups="open">Expand all</button> · <button type="button" class="link-btn" data-groups="close">Collapse all</button></span></div>
    ${out.join("") || `<p class="muted">Everything here is hidden.</p>`}`, "section");
}

function renderSpells(s, p, f) {
  if (!s.spells.length && !s.spellcasting) return "";
  const sc = s.spellcasting;
  const byLevel = new Map();
  // One row per spell; a spell known from two sources shows each source.
  const merged = new Map();
  for (const sp of s.spells) {
    const k = `${sp.id}|${sp.cast_ability ?? ""}|${sp.free_cast ? "free" : ""}`;
    if (!merged.has(k)) merged.set(k, { ...sp, sources: [sp.source] });
    else merged.get(k).sources.push(sp.source);
  }
  for (const sp of merged.values()) {
    const lvl = sp.level ?? -1;
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl).push(sp);
  }
  const levels = [...byLevel.keys()].sort((a, b) => (a < 0) - (b < 0) || a - b); // unknown-level spells last
  const slotRow = sc?.slots?.length ? hz("spells:slots", "Spell slots", "slot-row", sc.slots.map((n, i) => {
    const used = Math.min(p.slotsUsed[i + 1] ?? 0, n);
    return `<div class="slot-group"><span class="label">${ordinal(i + 1)}</span>${pips(n, used, `data-slot="${i + 1}"`, `${ordinal(i + 1)}-level slot`)}</div>`;
  }).join("")) : sc?.pact ? hz("spells:slots", "Pact slots", "slot-row", `<div class="slot-group"><span class="label">Pact slots (${ordinal(sc.pact.level)})</span>${pips(sc.pact.count, Math.min(p.pactUsed, sc.pact.count), 'data-pact', "Pact slot")}</div>`) : "";

  const spellRow = sp => {
    const e = f.snapshot.spells?.[sp.id];
    const id = `s:${sp.id}|${sp.sources[0]}`;
    if (!shown(`row:${id}`)) return "";
    const open = ui.printing || ui.open.has(id);
    const tags = [];
    if (sp.always_prepared) tags.push("always prepared");
    if (e?.concentration) tags.push("concentration");
    if (e?.ritual) tags.push("ritual");
    const on = (p.effects ?? []).some(x => x.spell === sp.id);
    if (on) tags.push("active");
    if (sp.fixed_dc != null) tags.push(`DC ${sp.fixed_dc}${sp.fixed_attack != null ? `, ${signed(sp.fixed_attack)} to hit` : ""}`);
    else if (sp.cast_ability && sc && sp.cast_ability !== sc.ability) tags.push(`${ABBR[sp.cast_ability]}, DC ${sp.dc}, ${signed(sp.attack)} to hit`);
    const freeKey = `${sp.id}|${sp.source}`;
    const free = sp.free_cast ? `<span class="free-cast">Free: ${pips(sp.free_cast.uses ?? 1, Math.min(p.freeCastUsed[freeKey] ?? 0, sp.free_cast.uses ?? 1), `data-free="${esc(freeKey)}"`, `Free casting of ${sp.name}`)}</span>` : "";
    return `<li class="spell-row hideable ${open ? "open" : ""}${isHidden(`row:${id}`) ? " is-hidden" : ""}">
      <div class="spell-line">
        ${hideBtn(`row:${id}`, sp.name)}
        <button type="button" class="feature-toggle" data-toggle="${esc(id)}" aria-expanded="${open}">
          <span>${esc(sp.name)}</span>
          <span class="muted">${esc([e?.casting_time, e?.range].filter(Boolean).join(", "))}</span>
          ${tags.length ? `<span class="spell-tags">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join("")}</span>` : ""}
        </button>
        ${free}
      </div>
      ${open ? `<div class="feature-body">
        ${e ? `<p class="muted">${esc([e.level === 0 ? `${e.school} cantrip` : `Level ${e.level} ${String(e.school ?? "").toLowerCase()}`, [].concat(e.components ?? []).join(", ") + (e.material ? ` (${e.material})` : ""), `${e.concentration ? "Concentration, " : ""}${e.duration ?? ""}`].filter(Boolean).join("; "))}</p>${md(String(e.text ?? "").replace(/^\s*#{1,6}\s+.*\n+/, ""))}` : `<p class="muted">This spell isn't in the content snapshot, so there's no description.</p>`}
        <p class="muted">From ${esc(sp.sources.join(" and "))}</p>
        ${hasEffect(e) && !ui.printing ? `<p class="fx-cast"><button type="button" class="btn" data-fx-cast="${esc(sp.id)}">${on ? "Cast again" : effectOptions(e) ? "Turn on…" : "Turn on"}</button>
          <span class="muted">${esc(describeEffect(e, effectOptions(e) ? 0 : null).slice(0, 2).join(" · "))}${effectOptions(e) ? " (pick a version)" : ""}</span></p>` : ""}
      </div>` : ""}
    </li>`;
  };

  const levelGroups = levels.map(l => {
    const title = l === 0 ? "Cantrips" : l < 0 ? "Not in the content snapshot" : `${ordinal(l)} level`;
    const rows = byLevel.get(l).sort((a, b) => a.name.localeCompare(b.name)).map(spellRow).join("");
    return rows.trim() ? hz(`spells:level:${l}`, title, "spell-level", `<h3 class="group-title">${esc(title)}</h3><ul class="spell-rows">${rows}</ul>`) : "";
  }).join("");

  return hz("panel:spells", "Spells", "panel spells-panel", `<h2>Spells</h2>
    ${sc ? (sc.classes?.length > 1 ? sc.classes : [{ ...sc, name: null }]).map(c => hz(`spells:stats:${c.name ?? "all"}`, `${c.name ?? "Spellcasting"} stats`, "spell-stats", `
      ${c.name ? `<div><span class="label">Class</span><strong>${esc(c.name)}</strong></div>` : ""}
      <div><span class="label">Ability</span><strong>${ABILITIES[c.ability]}</strong></div>
      <div><span class="label">Modifier</span><strong>${signed(s.mods[c.ability])}</strong></div>
      <div><span class="label">Save DC</span><strong>${c.dc}</strong></div>
      <div><span class="label">Attack</span><strong>${signed(c.attack)}${diceTag(sc.attackDice)}</strong></div>`)).join("") : ""}
    ${slotRow}
    ${levelGroups || `<p class="muted">Everything here is hidden.</p>`}`, "section");
}

// ---------- saving ----------
const slug = s => (s || "character").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character";

export function saveCharacterFile() {
  if (!state) return;
  state.file.updated = new Date().toISOString();
  const blob = new Blob([JSON.stringify(state.file, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${slug(state.file.details?.name)}.character.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  state.dirty = false;
  persist();
}

function updateSaveState() {
  const btn = root?.querySelector("[data-save]");
  if (btn) btn.innerHTML = `${ICONS.save}${state.dirty ? "Save file" : "Saved"}`;
}

// ---------- events ----------
function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for (const k of parts.slice(0, -1)) o = (o[k] ??= {});
  o[parts.at(-1)] = value;
}

const clampInt = (v, min, max) => Math.max(min, Math.min(max, Math.trunc(Number(v) || 0)));

function onInput(e) {
  const t = e.target;
  if (ui.itemPicker && t.matches("[data-ip-q]")) { ui.itemFilter.q = t.value; return applyItemFilter(); }
  if (ui.fxPicker && t.matches("[data-fx-q]")) { ui.fxPicker.q = t.value; return filterEffects(); }
  if (ui.itemPicker && t.matches("[data-ip-price]")) { ui.itemFilter.maxPrice = t.value.trim(); return applyItemFilter(); }
  // Custom item editor: typing updates the draft without a re-render.
  if (ui.itemDraft && t.dataset.draft && t.type !== "checkbox") { ui.itemDraft[t.dataset.draft] = t.value; return; }
  if (ui.itemDraft && t.dataset.fx != null && t.tagName !== "SELECT") { ui.itemDraft.effects[Number(t.dataset.fx)][t.dataset.fxField] = t.value; return; }
  if (t.dataset.play && (t.tagName === "TEXTAREA" || t.type === "text")) {
    change(p => setPath(p, t.dataset.play, t.value), { rerender: false });
  } else if (t.dataset.attack != null && t.dataset.field) {
    change(p => { p.attacks[Number(t.dataset.attack)][t.dataset.field] = t.value; }, { rerender: false });
  } else if (t.dataset.detail) {
    change((p, file) => { (file.details ??= {})[t.dataset.detail] = t.value; }, { rerender: false });
  }
}

function onChange(e) {
  const t = e.target;
  if (ui.fxPicker && t.matches("[data-fx-others]")) { ui.fxPicker.others = t.checked; return; }
  if (ui.itemPicker && t.closest(".ip-modal")) {
    const F = ui.itemFilter;
    if (t.matches("[data-ip-attune]")) F.attune = t.value;
    else if (t.matches("[data-ip-source]")) F.source = t.value;
    else if (t.matches("[data-ip-sort]")) { F.sort = t.value; return applyItemFilter(true); }
    else if (t.matches("[data-ip-mine]")) F.mine = t.checked;
    else if (t.matches("[data-ip-rules]")) F.rules = t.checked;
    else if (t.matches("[data-ip-intext]")) F.inText = t.checked;
    else return;
    return applyItemFilter();
  }
  if (ui.itemDraft && t.dataset.draft === "attunement") { ui.itemDraft.attunement = t.checked; return; }
  if (ui.itemDraft && t.dataset.fx != null) {
    const i = Number(t.dataset.fx);
    if (t.dataset.fxField === "kind") { ui.itemDraft.effects[i] = newEffect(t.value); render(); }
    else { ui.itemDraft.effects[i][t.dataset.fxField] = t.value; if (t.dataset.fxField === "atype") render(); }
    return;
  }
  if (t.dataset.draft) return;
  if (t.dataset.itemEquip) return itemChange(p => { const it = p.items.find(x => x.uid === t.dataset.itemEquip); if (it) it.equipped = t.checked; });
  if (t.dataset.itemAttune) {
    const p0 = state.file.play;
    if (t.checked && p0.items.filter(x => x.attuned && needsAttunement(itemEntry(state.file, x))).length >= 3
      && !confirm("You're already attuned to 3 items, the usual limit. Attune to this one anyway?")) { t.checked = false; return; }
    return itemChange(p => { const it = p.items.find(x => x.uid === t.dataset.itemAttune); if (it) it.attuned = t.checked; });
  }
  if (t.matches("[data-armor]")) return change(p => { p.armor = t.value; p.ac = null; });
  if (t.matches("[data-shield]")) return change(p => { p.shield = t.checked; });
  if (t.matches("[data-ac-method]")) return change(p => { p.acMethod = t.value; p.ac = null; });
  if (!t.dataset.play || t.type !== "number") return;
  const s = computed();
  change(p => {
    if (t.dataset.play === "ac") { const auto = armorView(s, p).ac; p.ac = t.value === "" || Number(t.value) === auto ? null : clampInt(t.value, 0, 40); }
    else if (t.dataset.play === "hp.current") p.hp.current = clampInt(t.value, 0, s.hp ?? 0);
    else setPath(p, t.dataset.play, clampInt(t.value, 0, 1e7));
  });
}

function togglePip(store, key, i) {
  const used = store[key] ?? 0;
  store[key] = i < used ? i : i + 1; // click a used pip to free it and those after; an unused one to spend up to it
}

function onClick(e) {
  // Clicking the dimmed backdrop closes the conditions window; clicking anywhere else closes a condition's tip.
  if (ui.condPicker && e.target.matches?.("[data-cond-back]")) { ui.condPicker = false; render(); return; }
  if (ui.itemPicker && e.target.matches?.("[data-ip-back]")) { closeItemPicker(); return; }
  if (ui.fxPicker && e.target.matches?.("[data-fx-back]")) { closeEffectPicker(); return; }
  if (ui.fxOpen && !e.target.closest(".cond-wrap")) { ui.fxOpen = null; if (!e.target.closest("button")) { render(); return; } }
  if (ui.condOpen && !e.target.closest(".cond-wrap")) { ui.condOpen = null; if (!e.target.closest("button")) { render(); return; } }
  const t = e.target.closest("button");
  if (!t || !state) return;
  const s = computed();
  const d = t.dataset;
  if (d.save !== undefined) { saveCharacterFile(); render(); return; }
  if (d.close !== undefined) {
    if (state.dirty && !confirm("You have changes that aren't in your character file yet. Close without saving?")) return;
    closeCharacter();
    location.hash = "#/";
    return;
  }
  if (d.levelup !== undefined) { location.hash = "#/levelup"; return; }
  if (d.editBuild !== undefined) { location.hash = "#/edit"; return; }
  if (d.print !== undefined) return exportPdf(s);
  if (d.layout !== undefined) { ui.layout = !ui.layout; render(); if (!ui.layout) window.scrollTo({ top: 0 }); return; }
  if (d.hide) return change(p => {
    const set = new Set(p.hidden ?? []);
    set.has(d.hide) ? set.delete(d.hide) : set.add(d.hide);
    p.hidden = [...set];
  });
  if (d.showAll !== undefined) return change(p => { p.hidden = []; });
  if (d.refreshContent !== undefined) return refreshContent(s);
  if (d.group) { ui.closedGroups.has(d.group) ? ui.closedGroups.delete(d.group) : ui.closedGroups.add(d.group); render(); return; }
  if (d.groups) {
    const keys = [...root.querySelectorAll("[data-group]")].map(b => b.dataset.group);
    if (d.groups === "close") keys.forEach(k => ui.closedGroups.add(k)); else ui.closedGroups.clear();
    render(); return;
  }
  if (d.toggle) { ui.open.has(d.toggle) ? ui.open.delete(d.toggle) : ui.open.add(d.toggle); render(); return; }
  if (d.slot) return change(p => togglePip(p.slotsUsed, d.slot, Number(d.i)));
  if (d.pact !== undefined) return change(p => { p.pactUsed = Number(d.i) < p.pactUsed ? Number(d.i) : Number(d.i) + 1; });
  if (d.resource) return change(p => togglePip(p.resourcesUsed, d.resource, Number(d.i)));
  if (d.featureUse) return change(p => togglePip(p.featureUses, d.featureUse, Number(d.i)));
  if (d.free) return change(p => togglePip(p.freeCastUsed, d.free, Number(d.i)));
  if (d.death) return change(p => togglePip(p.deathSaves, d.death, Number(d.i)));
  if (d.inspiration !== undefined) return change(p => { p.inspiration = !p.inspiration; });
  if (d.exh) return change(p => { p.exhaustion = clampInt((p.exhaustion ?? 0) + Number(d.exh), 0, 6); });
  if (d.hd) return change(p => {
    const row = s.hitDice.find(h => String(h.die) === d.die);
    if (row) p.hitDiceSpent[row.die] = clampInt((p.hitDiceSpent[row.die] ?? 0) + Number(d.hd), 0, row.count);
  });
  if (d.acReset !== undefined) return change(p => { p.ac = null; });
  if (d.condAdd !== undefined) { ui.condPicker = true; ui.condOpen = null; render(); root.querySelector(".cond-option")?.focus(); return; }
  if (d.condClose !== undefined) { ui.condPicker = false; render(); root.querySelector("[data-cond-add]")?.focus(); return; }
  if (d.condToggle) {
    const n = d.condToggle;
    change(p => { p.conditions = p.conditions.includes(n) ? p.conditions.filter(c => c !== n) : [...p.conditions, n].sort((a, b) => a.localeCompare(b)); });
    root.querySelector(`[data-cond-toggle="${CSS.escape(n)}"]`)?.focus();
    return;
  }
  if (d.condInfo) { ui.condOpen = ui.condOpen === d.condInfo ? null : d.condInfo; render(); root.querySelector(`[data-cond-info="${CSS.escape(d.condInfo)}"]`)?.focus(); return; }
  if (d.condRemove) { const n = d.condRemove; ui.condOpen = null; return change(p => { p.conditions = p.conditions.filter(c => c !== n); }); }
  if (ui.itemPicker && itemPickerClick(t)) return;
  if (d.fxAdd !== undefined) { ui.fxPicker = { q: "", others: false, added: null }; ui.fxOpen = null; render(); root.querySelector("[data-fx-q]")?.focus(); return; }
  if (d.fxClose !== undefined) { closeEffectPicker(); return; }
  if (d.fxPick) {
    const sel = d.fxFromSelect !== undefined ? root.querySelector(`[data-fx-select="${CSS.escape(d.fxPick)}"]`) : null;
    const opt = sel ? Number(sel.value) : d.fxOpt != null ? Number(d.fxOpt) : null;
    const sp = spellEntry(state.file, d.fxPick);
    const mine = !ui.fxPicker?.others && ownSpellIds(s).has(d.fxPick);
    if (addEffect(d.fxPick, opt, mine) && ui.fxPicker) { ui.fxPicker.added = effectName(sp, opt); render(); }
    return;
  }
  if (d.fxCast) {
    // From a spell row: no versions, so it goes straight on; with versions, the window opens on it.
    const sp = spellEntry(state.file, d.fxCast);
    if (effectOptions(sp)) { ui.fxPicker = { q: sp.name, others: false, added: null }; render(); root.querySelector("[data-fx-q]")?.focus(); return; }
    addEffect(d.fxCast, null, true);
    return;
  }
  if (d.fxInfo) { ui.fxOpen = ui.fxOpen === d.fxInfo ? null : d.fxInfo; render(); root.querySelector(`[data-fx-info="${CSS.escape(d.fxInfo)}"]`)?.focus(); return; }
  if (d.fxRemove) { const uid = d.fxRemove; ui.fxOpen = null; return removeEffects(x => x.uid === uid); }
  if (d.stateToggle) return toggleState(d.stateToggle, s);
  if (d.conc) {
    const c = ui.concCheck; ui.concCheck = null;
    if (d.conc === "lose" && c?.uids) return removeEffects(x => c.uids.includes(x.uid));
    render(); return;
  }
  if (d.itemOpen !== undefined) { ui.itemPicker = true; ui.itemFilter ??= newItemFilter(); ui.itemFilter.added = null; render(); root.querySelector("[data-ip-q]")?.focus(); return; }
  if (d.itemAdd) { if (ui.itemFilter) ui.itemFilter.added = loadedPack?.items?.[d.itemAdd]?.name ?? null; return addPackItem(d.itemAdd); }
  if (d.itemCustom !== undefined) { ui.itemDraft = { uid: null, name: "", text: "", attunement: false, effects: [newEffect("ac")] }; render(); root.querySelector('[data-focus="draft-name"]')?.focus(); return; }
  if (d.itemEdit) {
    const it = state.file.play.items.find(x => x.uid === d.itemEdit);
    if (it?.custom) { ui.itemDraft = { uid: it.uid, ...structuredClone(it.custom) }; render(); root.querySelector('[data-focus="draft-name"]')?.focus(); }
    return;
  }
  if (d.itemRemove) {
    const it = state.file.play.items.find(x => x.uid === d.itemRemove);
    const name = itemEntry(state.file, it)?.name ?? "this item";
    if (!confirm(`Remove ${name} from this character?`)) return;
    return itemChange(p => { p.items = p.items.filter(x => x.uid !== d.itemRemove); });
  }
  if (d.draftAddEffect !== undefined) { ui.itemDraft.effects.push(newEffect("ac")); render(); return; }
  if (d.draftRemoveEffect) { ui.itemDraft.effects.splice(Number(d.draftRemoveEffect), 1); render(); return; }
  if (d.draftCancel !== undefined) { ui.itemDraft = null; render(); return; }
  if (d.draftSave !== undefined) return saveDraft();
  if (d.addAttack !== undefined) return change(p => { p.attacks.push({ name: "", bonus: "", damage: "", notes: "" }); });
  if (d.removeAttack) return change(p => { p.attacks.splice(Number(d.removeAttack), 1); });
  if (d.hp) {
    const input = root.querySelector("[data-hp-amount]");
    const n = clampInt(input?.value, 0, 9999);
    if (!n) { input?.focus(); return; }
    return change(p => {
      if (d.hp === "heal") {
        p.hp.current = Math.min(s.hp ?? 0, p.hp.current + n);
        if (p.hp.current > 0) p.deathSaves = { success: 0, fail: 0 };
      } else {
        const fromTemp = Math.min(p.hp.temp, n);
        p.hp.temp -= fromTemp;
        p.hp.current = Math.max(0, p.hp.current - (n - fromTemp));
        // Taking damage while concentrating: a Constitution save, DC 10 or half the damage (up to 30).
        // Dropping to 0 Hit Points ends Concentration outright.
        const conc = concentrating(state.file);
        if (conc.length) {
          const names = conc.map(x => spellEntry(state.file, x.spell)?.name).join(", ");
          if (p.hp.current === 0) {
            const drop = new Set(conc.map(x => x.uid));
            p.effects = p.effects.filter(x => !drop.has(x.uid));
            ui.concCheck = { text: `You dropped to 0 Hit Points, so ${names} ended.` };
          } else ui.concCheck = { dc: Math.min(30, Math.max(10, Math.floor(n / 2))), uids: conc.map(x => x.uid), text: `Concentration: make a Constitution saving throw, DC ${Math.min(30, Math.max(10, Math.floor(n / 2)))}, to keep ${names}.` };
        }
      }
    });
  }
  if (d.rest) return rest(d.rest, s);
}

function rest(kind, s) {
  const msg = kind === "long"
    ? "Take a long rest? You regain all hit points, hit dice and spell slots, and one level of exhaustion. Effects that last 8 hours or less end."
    : "Take a short rest? Pact slots and short-rest features come back. Spend hit dice yourself to heal. Effects that last an hour or less end.";
  if (!confirm(msg)) return;
  change(p => {
    const shortOnes = s.resources.filter(r => r.recharge === "short");
    for (const r of shortOnes) p.resourcesUsed[r.id] = 0;
    for (const r of s.resources.filter(r => r.short_rest_regain)) p.resourcesUsed[r.id] = Math.max(0, (p.resourcesUsed[r.id] ?? 0) - r.short_rest_regain);
    for (const f of s.features.filter(f => f.uses?.recharge === "short")) p.featureUses[f.key] = 0;
    for (const sp of s.spells.filter(sp => sp.free_cast?.recharge === "short")) p.freeCastUsed[`${sp.id}|${sp.source}`] = 0;
    p.pactUsed = 0;
    p.states = []; // Rage and the like end with any rest
    p.effects = (p.effects ?? []).filter(x => !endsOnRest(spellEntry(state.file, x.spell), kind));
    ui.concCheck = null;
    // Effects that ended (Aid) can lower the Hit Point maximum, so heal to the new one.
    const maxNow = summaryFor(state.file).hp ?? p.hp.current;
    p.hp.current = Math.min(p.hp.current, maxNow);
    if (kind === "long") {
      p.hp.current = maxNow;
      p.hp.temp = 0;
      p.hitDiceSpent = {};
      p.slotsUsed = {};
      p.resourcesUsed = {};
      p.featureUses = {};
      p.freeCastUsed = {};
      p.deathSaves = { success: 0, fail: 0 };
      p.exhaustion = Math.max(0, (p.exhaustion ?? 0) - 1);
    }
  });
}
