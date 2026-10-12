// The character sheet. Everything it shows is computed from the character file's own
// snapshot of the content, so content-pack updates never change a finished character.
// Only `play` (HP, used slots, gear, notes) changes here; the build is read-only.
import { summarize, titleCase } from "./engine.js";
import { esc, md } from "./render.js";
import { ABILITIES, ABBR, ABILITY_KEYS, SKILLS, signed, ordinal } from "./rules.js";

const OPEN_KEY = "character-builder:sheet";
const COINS = ["cp", "sp", "ep", "gp", "pp"];

let state = null; // { file, dirty }
let root = null;
<<<<<<< HEAD
const ui = { open: new Set(), layout: false }; // expanded rows; layout-editing mode
=======
const ui = { open: new Set(), closedGroups: new Set(), printing: false }; // expanded feature/spell rows, collapsed feature groups
>>>>>>> d72a0dcb0a3ca9cfbddd3f932f5361dd5e7e0de9

// ---------- loading / persistence ----------
export function validateCharacter(data) {
  if (!data || data.kind !== "character") return "This isn't a character file.";
  if (data.format > 1) return "This character was saved by a newer version of the builder. Refresh the page and try again.";
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
      if (s?.file && !validateCharacter(s.file)) state = s;
    }
  } catch {}
  return state?.file ?? null;
}

export function openCharacter(file, { dirty = false } = {}) {
  state = { file: structuredClone(file), dirty };
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
const computed = () => summarize(state.file.build, snapshotPack(state.file));

function ensurePlay() {
  const s = computed();
  const p = (state.file.play ??= {});
  p.hp ??= { current: s.hp ?? 0, temp: 0 };
  p.hitDiceSpent ??= 0;
  p.deathSaves ??= { success: 0, fail: 0 };
  p.inspiration ??= false;
  p.exhaustion ??= 0;
  p.slotsUsed ??= {};
  p.pactUsed ??= 0;
  p.resourcesUsed ??= {};
  p.featureUses ??= {};
  p.freeCastUsed ??= {};
  p.ac ??= null;
  p.attacks ??= [];
  p.equipment ??= startingEquipmentText();
  p.coins ??= { cp: 0, sp: 0, ep: 0, gp: s.gold ?? 0, pp: 0 };
  p.notes ??= "";
<<<<<<< HEAD
  p.hidden ??= [];   // ids of sheet elements the player hid
=======
  p.characterNotes ??= "";
>>>>>>> d72a0dcb0a3ca9cfbddd3f932f5361dd5e7e0de9
}

function startingEquipmentText() {
  const f = state.file;
  const lines = [];
  const cls = f.snapshot.classes?.[f.build.class];
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
  render();
}
export function unmountSheet() {
  if (!root) return;
  root.removeEventListener("click", onClick);
  root.removeEventListener("change", onChange);
  root.removeEventListener("input", onInput);
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

function featureGroup(f) {
  const k = f.key ?? "";
  if (k.includes(">feat.")) return "feats";
  if (k.startsWith("species.")) return "species";
  if (k.startsWith("background.")) return "background";
  return "class";
}

const rechargeLabel = r => ({ short: "short rest", long: "long rest", dawn: "dawn" })[r] ?? r;

// ---------- render ----------
function render() {
  if (!root || !state) return;
  const focusId = document.activeElement?.dataset?.focus;
  const f = state.file;
  const s = computed();
  const p = f.play;
  const b = f.build;
  const cls = f.snapshot.classes?.[b.class];
  const sub = f.snapshot.subclasses?.[b.subclass];
  const species = f.snapshot.species?.[b.species];
  const bg = f.snapshot.backgrounds?.[b.background];
  const exh = p.exhaustion ?? 0;
  const speed = Math.max(0, s.speed - 5 * exh);
  const ac = p.ac ?? s.ac;
  const hpMax = s.hp ?? 0;

<<<<<<< HEAD
  const statBoxes = [
    box("stat:ac", "Armor class", "stat-box ac-box", `
=======
  root.innerHTML = `
  <article class="sheet">
    <header class="sheet-head">
      <div class="sheet-id">
        <h1>${esc(f.details?.name || "Unnamed character")}</h1>
        <p>${esc([`Level ${s.level} ${classText}`, species?.name, bg?.name, f.details?.alignment].filter(Boolean).join(", "))}</p>
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn" data-levelup ${s.level >= 20 ? "disabled" : ""}>Level up</button>
        <button type="button" class="btn" data-edit-build>Edit in builder</button>
        <button type="button" class="btn" data-print>Export PDF</button>
        <button type="button" class="btn" data-rest="short">Short rest</button>
        <button type="button" class="btn" data-rest="long">Long rest</button>
        <button type="button" class="btn btn-primary" data-save>${state.dirty ? "Save file" : "Saved"}</button>
        <button type="button" class="btn btn-quiet" data-close>Close</button>
      </div>
    </header>
    ${loadedPack && loadedPack.meta?.version !== f.pack?.version ? `<div class="update-note">
      <p>Built with content pack ${esc(f.pack?.version ?? "unknown")}. The pack loaded here is ${esc(loadedPack.meta?.version)}.</p>
      <button type="button" class="btn" data-refresh-content>Update this character's content</button>
    </div>` : ""}

    <section class="combat-strip" aria-label="Combat">
      <div class="stat-box ac-box">
>>>>>>> d72a0dcb0a3ca9cfbddd3f932f5361dd5e7e0de9
        <label for="ac-input">Armor class</label>
        <input id="ac-input" type="number" data-play="ac" data-focus="ac" value="${ac}" min="0" max="40">
        <small>${p.ac == null ? "unarmored" : `<button type="button" class="link-btn" data-ac-reset>reset to ${s.ac}</button>`}</small>`),
    box("stat:initiative", "Initiative", "stat-box", `<span class="label">Initiative</span><strong>${signed(s.initiative - 2 * exh)}</strong>`),
    box("stat:speed", "Speed", "stat-box", `<span class="label">Speed</span><strong>${speed} ft</strong>${exh ? `<small>−${5 * exh} from exhaustion</small>` : ""}`),
    box("stat:proficiency", "Proficiency", "stat-box", `<span class="label">Proficiency</span><strong>${signed(s.pb)}</strong>`),
    box("stat:perception", "Passive Perception", "stat-box", `<span class="label">Passive Perception</span><strong>${s.passivePerception}</strong>`),
    box("stat:size", "Size", "stat-box", `<span class="label">Size</span><strong class="small-value">${esc(s.size ?? "Medium")}</strong>${s.darkvision ? `<small>Darkvision ${s.darkvision} ft</small>` : ""}`),
    box("stat:hp", "Hit points", "hp-box", `
        <div class="hp-numbers">
          <label class="hp-current"><span class="label">Hit points</span>
            <input type="number" data-play="hp.current" data-focus="hp" value="${p.hp.current}" min="0" max="${hpMax}"><span class="hp-max">/ ${hpMax}</span></label>
          <label class="hp-temp"><span class="label">Temporary</span><input type="number" data-play="hp.temp" data-focus="temp" value="${p.hp.temp}" min="0"></label>
        </div>
        <div class="hp-adjust">
          <input type="number" min="0" placeholder="Amount" data-hp-amount data-focus="hp-amount" aria-label="Damage or healing amount">
          <button type="button" class="btn" data-hp="damage">Damage</button>
          <button type="button" class="btn" data-hp="heal">Heal</button>
        </div>
        <div class="hp-bar" aria-hidden="true"><span style="width:${hpMax ? Math.min(100, (p.hp.current / hpMax) * 100) : 0}%"></span></div>`),
    box("stat:hitdice", "Hit dice", "stat-box tracker-box", `
        <span class="label">Hit dice (d${s.hitDie})</span>
        <span class="stepper"><button type="button" class="step-btn" data-hd="1" ${p.hitDiceSpent >= s.level ? "disabled" : ""} aria-label="Spend a hit die">−</button>
          <strong>${s.level - p.hitDiceSpent}</strong><span class="muted">/ ${s.level}</span>
          <button type="button" class="step-btn" data-hd="-1" ${p.hitDiceSpent <= 0 ? "disabled" : ""} aria-label="Regain a hit die">+</button></span>`),
    box("stat:death", "Death saves", "stat-box tracker-box", `
        <span class="label">Death saves</span>
        <span class="death"><span>Success</span>${pips(3, p.deathSaves.success, 'data-death="success"', "Death save success")}</span>
        <span class="death"><span>Fail</span>${pips(3, p.deathSaves.fail, 'data-death="fail"', "Death save failure")}</span>`),
    box("stat:inspiration", "Heroic Inspiration", "stat-box tracker-box", `
        <span class="label">Heroic Inspiration</span>
        <button type="button" class="toggle ${p.inspiration ? "on" : ""}" data-inspiration aria-pressed="${p.inspiration}">${p.inspiration ? "Have it" : "None"}</button>`),
    box("stat:exhaustion", "Exhaustion", "stat-box tracker-box", `
        <span class="label">Exhaustion</span>
        <span class="stepper"><button type="button" class="step-btn" data-exh="-1" ${exh <= 0 ? "disabled" : ""} aria-label="Remove a level of exhaustion">−</button>
          <strong>${exh}</strong>
          <button type="button" class="step-btn" data-exh="1" ${exh >= 6 ? "disabled" : ""} aria-label="Add a level of exhaustion">+</button></span>
        ${exh ? `<small>−${2 * exh} to d20 tests</small>` : ""}`),
  ].join("");

  const abilities = ABILITY_KEYS.map(a => {
    const save = s.saves.find(x => x.ability === a);
    const skills = s.skills.filter(k => k.ability === a);
    return box(`ability:${a}`, ABILITIES[a], "ability-block", `
      <div class="ability-top"><h3>${ABILITIES[a]}</h3><span class="ability-mod">${signed(s.mods[a])}</span><span class="ability-score">${s.scores[a]}</span></div>
      <ul>
        <li class="${save.prof ? "prof" : ""}"><span class="dot" aria-label="${save.prof ? "proficient" : "not proficient"}"></span>Saving throw<span class="val">${signed(save.bonus)}</span></li>
        ${skills.map(k => `<li class="${k.prof ? "prof" : ""} ${k.expertise ? "expert" : ""}"><span class="dot" aria-label="${k.expertise ? "expertise" : k.prof ? "proficient" : "not proficient"}"></span>${esc(k.name)}<span class="val">${signed(k.bonus)}</span></li>`).join("")}
      </ul>`);
  }).join("");

<<<<<<< HEAD
  const mainCol = [renderAttacks(p), renderResources(s, p), renderFeatures(s, p, f)].join("");
  const sideCol = [
    box("panel:training", "Training", "panel", `<h2>Training</h2>
      <dl class="facts compact one-col">
        <div><dt>Armor</dt><dd>${esc(uniq(s.proficiencies.armor).join(", ") || "None")}</dd></div>
        <div><dt>Weapons</dt><dd>${esc(uniq(s.proficiencies.weapon).join(", ") || "None")}</dd></div>
        <div><dt>Tools</dt><dd>${esc(uniq(s.proficiencies.tool).join(", ") || "None")}</dd></div>
        <div><dt>Languages</dt><dd>${esc(uniq(s.proficiencies.language).join(", "))}</dd></div>
      </dl>`, "section"),
    box("panel:equipment", "Equipment", "panel", `<h2>Equipment</h2>
      <label class="visually-hidden" for="equip">Equipment</label>
      <textarea id="equip" rows="10" data-play="equipment" data-focus="equipment" placeholder="One item per line">${esc(p.equipment)}</textarea>
      <div class="coins">${COINS.map(c => `<label><span>${c.toUpperCase()}</span><input type="number" min="0" data-play="coins.${c}" data-focus="coin-${c}" value="${p.coins[c] ?? 0}"></label>`).join("")}</div>`, "section"),
  ].join("");
  const gridCls = ["sheet-grid", abilities.trim() && "has-abil", mainCol.trim() && "has-main", sideCol.trim() && "has-side"].filter(Boolean).join(" ");
  const hiddenCount = (p.hidden ?? []).length;

  root.innerHTML = `
  <article class="sheet ${ui.layout ? "layout-mode" : ""}">
    <header class="sheet-head">
      <div class="sheet-id">
        <h1>${esc(f.details?.name || "Unnamed character")}</h1>
        <p>${esc([`Level ${s.level} ${cls?.name ?? ""}${sub ? ` (${sub.name})` : ""}`, species?.name, bg?.name, f.details?.alignment].filter(Boolean).join(", "))}</p>
=======
      <div class="main-col">
        ${renderAttacks(s, p)}
        ${renderClassStats(s)}
        <section class="panel"><h2><label for="char-notes">Your notes</label></h2>
          ${box(`<textarea id="char-notes" rows="14" data-play="characterNotes" data-focus="char-notes" placeholder="Reminders, combos, tactics, anything you want handy during play">${esc(p.characterNotes)}</textarea>`, p.characterNotes)}
        </section>
        ${renderResources(s, p)}
        ${renderFeatures(s, p, f)}
>>>>>>> d72a0dcb0a3ca9cfbddd3f932f5361dd5e7e0de9
      </div>
      <div class="sheet-actions">
        ${ui.layout ? "" : `<button type="button" class="btn" data-rest="short">Short rest</button>
        <button type="button" class="btn" data-rest="long">Long rest</button>`}
        <button type="button" class="btn ${ui.layout ? "btn-primary" : ""}" data-layout aria-pressed="${ui.layout}">${ui.layout ? "Done editing layout" : "Edit layout"}</button>
        ${ui.layout ? "" : `<button type="button" class="btn btn-primary" data-save>${state.dirty ? "Save file" : "Saved"}</button>
        <button type="button" class="btn btn-quiet" data-close>Close</button>`}
      </div>
    </header>
    ${ui.layout ? `<div class="layout-banner" role="status">
      <p><strong>Editing layout.</strong> Hide anything you don't need during play: whole panels, single features, spells or boxes. Hidden items are dimmed here and gone from the normal view. Your layout is saved in the character file.</p>
      ${hiddenCount ? `<button type="button" class="btn" data-show-all>Show everything (${hiddenCount} hidden)</button>` : ""}
    </div>` : ""}

<<<<<<< HEAD
    ${statBoxes ? `<section class="combat-strip" aria-label="Combat">${statBoxes}</section>` : ""}

    <div class="${gridCls}">
      ${abilities.trim() ? `<section class="abilities-col" aria-label="Abilities and skills">${abilities}</section>` : ""}
      ${mainCol.trim() ? `<div class="main-col">${mainCol}</div>` : ""}
      ${sideCol.trim() ? `<aside class="side-col">${sideCol}</aside>` : ""}
=======
      <aside class="side-col">
        <section class="panel"><h2>Training</h2>
          <dl class="facts compact one-col">
            <div><dt>Armor</dt><dd>${esc(uniq(s.proficiencies.armor).join(", ") || "None")}</dd></div>
            <div><dt>Weapons</dt><dd>${esc(uniq(s.proficiencies.weapon).join(", ") || "None")}</dd></div>
            <div><dt>Tools</dt><dd>${esc(uniq(s.proficiencies.tool).join(", ") || "None")}</dd></div>
            <div><dt>Languages</dt><dd>${esc(uniq(s.proficiencies.language).join(", "))}</dd></div>
          </dl>
        </section>
        ${renderDefenses(s)}
        <section class="panel"><h2>Equipment</h2>
          <label class="visually-hidden" for="equip">Equipment</label>
          ${box(`<textarea id="equip" rows="10" data-play="equipment" data-focus="equipment" placeholder="One item per line">${esc(p.equipment)}</textarea>`, p.equipment)}
          <div class="coins">${COINS.map(c => `<label><span>${c.toUpperCase()}</span><input type="number" min="0" data-play="coins.${c}" data-focus="coin-${c}" value="${p.coins[c] ?? 0}"></label>`).join("")}</div>
        </section>
      </aside>
>>>>>>> d72a0dcb0a3ca9cfbddd3f932f5361dd5e7e0de9
    </div>

    ${renderSpells(s, p, f)}

    ${box("panel:notes", "Notes", "panel notes-panel", `
      <h2>Notes</h2>
      <div class="notes-grid">
<<<<<<< HEAD
        <label class="field"><span>Session notes</span><textarea rows="6" data-play="notes" data-focus="notes">${esc(p.notes)}</textarea></label>
        <label class="field"><span>Appearance and backstory</span><textarea rows="6" data-detail="backstory" data-focus="backstory">${esc(f.details?.backstory ?? "")}</textarea></label>
      </div>`, "section")}
    <p class="sheet-foot muted">${!ui.layout && hiddenCount ? `${hiddenCount} item${hiddenCount === 1 ? " is" : "s are"} hidden. <button type="button" class="link-btn" data-layout>Edit layout</button> to bring ${hiddenCount === 1 ? "it" : "them"} back. ` : ""}Built with content pack ${esc(f.pack?.version ?? "unknown")}. Last saved ${f.updated ? new Date(f.updated).toLocaleString() : "never"}.</p>
=======
        <label class="field"><span>Session notes</span>${box(`<textarea rows="6" data-play="notes" data-focus="notes">${esc(p.notes)}</textarea>`, p.notes)}</label>
        <label class="field"><span>Appearance and backstory</span>${box(`<textarea rows="6" data-detail="backstory" data-focus="backstory">${esc(f.details?.backstory ?? "")}</textarea>`, f.details?.backstory)}</label>
      </div>
    </section>
    <p class="sheet-foot muted">Built with content pack ${esc(f.pack?.version ?? "unknown")}. Last saved ${f.updated ? new Date(f.updated).toLocaleString() : "never"}.</p>
>>>>>>> d72a0dcb0a3ca9cfbddd3f932f5361dd5e7e0de9
  </article>`;

  if (focusId) {
    const el = root.querySelector(`[data-focus="${CSS.escape(focusId)}"]`);
    if (el) el.focus();
  }
}

<<<<<<< HEAD
=======
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
  const res = resolve(f.build, merged);
  change((p, file) => {
    file.snapshot = snapshotFor(res, merged);
    file.pack = { version: loadedPack.meta?.version, built: loadedPack.meta?.built };
    const after = summarize(file.build, { meta: {}, ...file.snapshot });
    const delta = (after.hp ?? 0) - (before.hp ?? 0);
    p.hp.current = Math.max(0, Math.min(after.hp ?? 0, p.hp.current + delta));
  });
}

// ---------- armor, AC and conditional speed ----------
// Which AC calculations apply with the armor and shield toggles, which one is used, and the
// speed bonuses that switch off in armor (Unarmored Movement) or heavy armor (Fast Movement).
function armorView(s, p) {
  const armored = p.armor && p.armor !== "none";
  const options = armored ? [] : s.acOptions.filter(o => o.armor === "none" && (!p.shield || o.shield));
  const best = options.slice().sort((a, b) => b.value - a.value)[0];
  const chosen = options.find(o => o.name === p.acMethod) ?? best;
  const ac = chosen ? chosen.value + (p.shield ? 2 : 0) : null;
  const fails = req => ({
    no_armor: armored, no_heavy_armor: p.armor === "heavy", no_shield: !!p.shield, unarmored: armored || !!p.shield,
  })[req] ?? false;
  const speedLost = (s.conditionalStats ?? []).filter(c => c.stat === "speed" && fails(c.requires)).reduce((n, c) => n + (c.value ?? 0), 0);
  const lostAc = s.acOptions.filter(o => o.armor === "none" && !options.includes(o) && o.source !== "Core rules").map(o => o.name);
  const note = armored ? "Your armor sets your AC; type it in the box."
    : lostAc.length ? `${lostAc.join(", ")} doesn't work with a shield.` : "";
  const why = armored ? "in armor" : "with a shield";
  return { why, options, method: chosen?.name ?? null, ac, label: chosen ? `${chosen.name}${p.shield ? " + shield" : ""}` : "", speed: s.speed - speedLost, speedLost, note };
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
  return `<section class="panel"><h2>At a glance</h2><dl class="facts compact glance">${[...rows.values()].map(r =>
    `<div><dt>${esc(r.label)}</dt><dd>${esc(r.value)}${r.from.length && !(r.from.length === 1 && r.label.startsWith(r.from[0])) ? ` <span class="muted">${esc(r.from.join(", "))}</span>` : ""}</dd></div>`).join("")}</dl></section>`;
}

// Resistances and the advantages that only apply in some situations.
function renderDefenses(s) {
  const res = s.resistances ?? [];
  const adv = (s.advantages ?? []).filter(a => a.vs || a.while || a.on === "check");
  if (!res.length && !adv.length) return "";
  const what = a => a.on === "save" ? `${a.abilities ? a.abilities.map(x => ABBR[x]).join(", ") + " saves" : "Saves"}${a.vs ? ` against ${a.vs}` : ""}`
    : a.on === "check" ? `${a.abilities ? a.abilities.map(x => ABBR[x]).join(", ") + " checks" : "Checks"}${a.vs ? ` for ${a.vs}` : ""}`
    : a.on === "initiative" ? "Initiative" : "Attacks";
  return `<section class="panel"><h2>Defenses</h2><dl class="facts compact one-col">
    ${res.map(r => `<div><dt>Resistance${r.while ? ` while ${esc(r.while)}` : ""}</dt><dd>${esc(r.damage.join(", "))} <span class="muted">${esc(r.source)}</span></dd></div>`).join("")}
    ${adv.map(a => `<div><dt>Advantage${a.while ? ` while ${esc(a.while)}` : ""}</dt><dd>${esc(what(a))} <span class="muted">${esc(a.source)}</span></dd></div>`).join("")}
  </dl></section>`;
}

>>>>>>> d72a0dcb0a3ca9cfbddd3f932f5361dd5e7e0de9
const uniq = arr => [...new Set(arr.map(x => x.value ?? x))];

// ---------- hiding ----------
// Every hideable element has a stable id stored in play.hidden. In normal view a hidden
// element isn't rendered at all; in layout mode it's shown dimmed with a Show button.
const isHidden = id => !!state.file.play.hidden?.includes(id);
const visible = id => ui.layout || !isHidden(id);

function hideBtn(id, label) {
  if (!ui.layout) return "";
  const h = isHidden(id);
  return `<button type="button" class="hide-btn ${h ? "is-off" : ""}" data-hide="${esc(id)}" aria-pressed="${h}" aria-label="${h ? "Show" : "Hide"} ${esc(label)}">${h ? "Show" : "Hide"}</button>`;
}

function box(id, label, cls, inner, tag = "div") {
  if (!visible(id)) return "";
  return `<${tag} class="${cls} hideable${isHidden(id) ? " is-hidden" : ""}">${hideBtn(id, label)}${inner}</${tag}>`;
}

function renderAttacks(p) {
  return box("panel:attacks", "Weapons and attacks", "panel", `<h2>Weapons and attacks</h2>
    ${p.attacks.length ? `<table class="attack-table">
      <thead><tr><th scope="col">Name</th><th scope="col">Attack</th><th scope="col">Damage</th><th scope="col">Notes</th><th><span class="visually-hidden">Remove</span></th></tr></thead>
      <tbody>${p.attacks.map((a, i) => `<tr>
        <td><input type="text" data-attack="${i}" data-field="name" data-focus="atk-${i}-name" value="${esc(a.name)}" aria-label="Attack name"></td>
        <td><input type="text" data-attack="${i}" data-field="bonus" data-focus="atk-${i}-bonus" value="${esc(a.bonus)}" aria-label="Attack bonus" class="narrow"></td>
        <td><input type="text" data-attack="${i}" data-field="damage" data-focus="atk-${i}-damage" value="${esc(a.damage)}" aria-label="Damage"></td>
        <td><input type="text" data-attack="${i}" data-field="notes" data-focus="atk-${i}-notes" value="${esc(a.notes)}" aria-label="Notes"></td>
        <td><button type="button" class="link-btn" data-remove-attack="${i}" aria-label="Remove ${esc(a.name || "attack")}">Remove</button></td>
<<<<<<< HEAD
      </tr>`).join("")}</tbody></table>` : `<p class="muted">Add your weapons here. Attack bonus is your Strength or Dexterity modifier plus your proficiency bonus if you're trained with it.</p>`}
    <button type="button" class="btn" data-add-attack>Add an attack</button>`, "section");
=======
      </tr>`).join("")}</tbody></table>` : `<p class="muted attack-hint">Add your weapons here. Attack bonus is your Strength or Dexterity modifier plus your proficiency bonus if you're trained with it.</p>`}
    <button type="button" class="btn" data-add-attack>Add an attack</button>
  </section>`;
>>>>>>> d72a0dcb0a3ca9cfbddd3f932f5361dd5e7e0de9
}

function renderResources(s, p) {
  const withUses = s.features.filter(f => f.uses?.max);
  if (!s.resources.length && !withUses.length) return "";
  const rows = [
    ...s.resources.map(r => {
      const used = Math.min(p.resourcesUsed[r.id] ?? 0, r.max ?? 0);
      return box(`res:${r.id}`, r.name, "res-row", `<span class="res-name">${esc(r.name)}</span>${pips(r.max ?? 0, used, `data-resource="${esc(r.id)}"`, r.name)}
        <span class="muted res-note">${esc(`${r.max - used} left. All back on a ${rechargeLabel(r.recharge)}${r.short_rest_regain ? `, ${r.short_rest_regain} back on a short rest` : ""}`)}</span>`, "li");
    }),
    ...withUses.map(f => {
      const used = Math.min(p.featureUses[f.key] ?? 0, f.uses.max);
      return box(`use:${f.key}`, f.name, "res-row", `<span class="res-name">${esc(f.name)}</span>${pips(f.uses.max, used, `data-feature-use="${esc(f.key)}"`, f.name)}
        <span class="muted res-note">Back on a ${esc(rechargeLabel(f.uses.recharge))}</span>`, "li");
    }),
  ].join("");
  return box("panel:resources", "Limited uses", "panel", `<h2>Limited uses</h2>
    ${rows ? `<ul class="resource-list">${rows}</ul>` : `<p class="muted">Everything here is hidden.</p>`}`, "section");
}

function renderFeatures(s, p, f) {
  const groups = { class: [], species: [], background: [], feats: [] };
  for (const feat of s.features) groups[featureGroup(feat)].push(feat);
  const titles = { class: "Class features", species: `${f.snapshot.species?.[f.build.species]?.name ?? "Species"} traits`, background: "Background", feats: "Feat features" };
  const featEntries = s.feats.map(x => ({ ...x, entry: f.snapshot.feats?.[x.id] }));
<<<<<<< HEAD
  const row = (id, name, sourceText, body) => {
    if (!visible(`row:${id}`)) return "";
    const open = ui.open.has(id);
    return `<li class="feature-row hideable ${open ? "open" : ""}${isHidden(`row:${id}`) ? " is-hidden" : ""}">
      ${hideBtn(`row:${id}`, name)}
      <button type="button" class="feature-toggle" data-toggle="${esc(id)}" aria-expanded="${open}"><span>${esc(name)}</span><span class="muted">${esc(sourceText)}</span></button>
=======
  const featFeatureNames = new Set(featEntries.map(x => x.name));
  const row = (id, name, sourceText, body, chips = "") => {
    const open = ui.printing || ui.open.has(id);
    return `<li class="feature-row ${open ? "open" : ""}">
      <button type="button" class="feature-toggle" data-toggle="${esc(id)}" aria-expanded="${open}"><span>${esc(name)}${chips}</span><span class="muted">${esc(sourceText)}</span></button>
>>>>>>> d72a0dcb0a3ca9cfbddd3f932f5361dd5e7e0de9
      ${open ? `<div class="feature-body">${body || `<p class="muted">No description in the content snapshot.</p>`}</div>` : ""}
    </li>`;
  };
  const strip = t => String(t ?? "").replace(/^\s*#{1,6}\s+.*\n+/, "");
  const group = (gid, title, rowsHtml) => {
    if (!rowsHtml.trim()) return "";
    return box(`group:${gid}`, title, "feature-group", `<h3 class="group-title">${esc(title)}</h3><ul class="feature-rows">${rowsHtml}</ul>`);
  };
<<<<<<< HEAD
  const body = [
    ...Object.entries(groups).filter(([, list]) => list.length).map(([g, list]) =>
      group(`features:${g}`, titles[g], list.map(x => row(`f:${x.key}`, x.name, x.source, md(x.text))).join(""))),
    featEntries.length ? group("feats", "Feats", featEntries.map(x => row(`feat:${x.key}`, x.name, `from ${x.source}`, md(strip(x.entry?.text)))).join("")) : "",
  ].join("");
  return box("panel:features", "Features and traits", "panel", `<h2>Features and traits</h2>${body || `<p class="muted">Everything here is hidden.</p>`}`, "section");
=======
  const section = (key, title, sub, count, body) => {
    const closed = !ui.printing && ui.closedGroups.has(key);
    return `<div class="feature-group ${closed ? "closed" : ""}">
      <button type="button" class="group-toggle" data-group="${esc(key)}" aria-expanded="${!closed}">
        <span class="group-title">${esc(title)}${sub ? ` <span class="group-sub">${esc(sub)}</span>` : ""}</span>
        <span class="muted">${count}</span></button>
      ${closed ? "" : body}
    </div>`;
  };
  const out = [];
  for (const [key, g] of groups) {
    if (key === "feats") {
      const extra = g.items.filter(x => !featFeatureNames.has(x.name)); // a feat's own feature repeats the feat
      const n = featEntries.length + extra.length;
      if (!n) continue;
      out.push(section(key, g.title, null, n, `<ul class="feature-rows">${featEntries.map(x =>
        row(`feat:${x.key}`, x.name, `from ${x.source}`, `${(() => { const ff = g.items.find(i => i.name === x.name); return ff ? featureBody({ ...ff, text: "" }) : ""; })()}${md(strip(x.entry?.text))}`, featureChips(g.items.find(i => i.name === x.name) ?? {}))).join("")}
        ${extra.map(x => row(`f:${x.key}`, x.name, x.source, featureBody(x), featureChips(x))).join("")}</ul>`));
      continue;
    }
    if (!g.items.length) continue;
    out.push(section(key, g.title, g.sub, g.items.length, `<ul class="feature-rows">${g.items.map(x => row(`f:${x.key}`, x.name, where(x, key), featureBody(x), featureChips(x))).join("")}</ul>`));
  }
  return `<section class="panel features-panel"><div class="panel-head"><h2>Features and traits</h2>
      <span class="panel-tools"><button type="button" class="link-btn" data-groups="open">Expand all</button> · <button type="button" class="link-btn" data-groups="close">Collapse all</button></span></div>
    ${out.join("")}
  </section>`;
>>>>>>> d72a0dcb0a3ca9cfbddd3f932f5361dd5e7e0de9
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
  const slotRow = sc?.slots?.length ? box("spells:slots", "Spell slots", "slot-row", sc.slots.map((n, i) => {
    const used = Math.min(p.slotsUsed[i + 1] ?? 0, n);
    return `<div class="slot-group"><span class="label">${ordinal(i + 1)}</span>${pips(n, used, `data-slot="${i + 1}"`, `${ordinal(i + 1)}-level slot`)}</div>`;
  }).join("")) : sc?.pact ? box("spells:slots", "Pact slots", "slot-row", `<div class="slot-group"><span class="label">Pact slots (${ordinal(sc.pact.level)})</span>${pips(sc.pact.count, Math.min(p.pactUsed, sc.pact.count), 'data-pact', "Pact slot")}</div>`) : "";

  const spellRow = sp => {
    const e = f.snapshot.spells?.[sp.id];
    const id = `s:${sp.id}|${sp.sources[0]}`;
<<<<<<< HEAD
    if (!visible(`row:${id}`)) return "";
    const open = ui.open.has(id);
=======
    const open = ui.printing || ui.open.has(id);
>>>>>>> d72a0dcb0a3ca9cfbddd3f932f5361dd5e7e0de9
    const tags = [];
    if (sp.always_prepared) tags.push("always prepared");
    if (e?.concentration) tags.push("concentration");
    if (e?.ritual) tags.push("ritual");
    if (sp.cast_ability && sc && sp.cast_ability !== sc.ability) tags.push(`${ABBR[sp.cast_ability]}, DC ${sp.dc}, ${signed(sp.attack)} to hit`);
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
      </div>` : ""}
    </li>`;
  };

  const levelGroups = levels.map(l => {
    const title = l === 0 ? "Cantrips" : l < 0 ? "Not in the content snapshot" : `${ordinal(l)} level`;
    const rows = byLevel.get(l).sort((a, b) => a.name.localeCompare(b.name)).map(spellRow).join("");
    return rows.trim() ? box(`spells:level:${l}`, title, "feature-group", `<h3 class="group-title">${esc(title)}</h3><ul class="spell-rows">${rows}</ul>`) : "";
  }).join("");

  return box("panel:spells", "Spells", "panel spells-panel", `<h2>Spells</h2>
    ${sc ? box("spells:stats", "Spellcasting stats", "spell-stats", `
      <div><span class="label">Ability</span><strong>${ABILITIES[sc.ability]}</strong></div>
      <div><span class="label">Modifier</span><strong>${signed(s.mods[sc.ability])}</strong></div>
      <div><span class="label">Save DC</span><strong>${sc.dc}</strong></div>
      <div><span class="label">Attack</span><strong>${signed(sc.attack)}</strong></div>`) : ""}
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
  if (btn) btn.textContent = state.dirty ? "Save file" : "Saved";
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
  if (!t.dataset.play || t.type !== "number") return;
  const s = computed();
  change(p => {
    if (t.dataset.play === "ac") p.ac = t.value === "" || Number(t.value) === s.ac ? null : clampInt(t.value, 0, 40);
    else if (t.dataset.play === "hp.current") p.hp.current = clampInt(t.value, 0, s.hp ?? 0);
    else setPath(p, t.dataset.play, clampInt(t.value, 0, 1e7));
  });
}

function togglePip(store, key, i) {
  const used = store[key] ?? 0;
  store[key] = i < used ? i : i + 1; // click a used pip to free it and those after; an unused one to spend up to it
}

function onClick(e) {
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
<<<<<<< HEAD
=======
  if (d.levelup !== undefined) { location.hash = "#/levelup"; return; }
  if (d.editBuild !== undefined) { location.hash = "#/edit"; return; }
  if (d.print !== undefined) return exportPdf(s);
  if (d.refreshContent !== undefined) return refreshContent(s);
  if (d.group) { ui.closedGroups.has(d.group) ? ui.closedGroups.delete(d.group) : ui.closedGroups.add(d.group); render(); return; }
  if (d.groups) {
    const keys = [...root.querySelectorAll("[data-group]")].map(b => b.dataset.group);
    if (d.groups === "close") keys.forEach(k => ui.closedGroups.add(k)); else ui.closedGroups.clear();
    render(); return;
  }
>>>>>>> d72a0dcb0a3ca9cfbddd3f932f5361dd5e7e0de9
  if (d.toggle) { ui.open.has(d.toggle) ? ui.open.delete(d.toggle) : ui.open.add(d.toggle); render(); return; }
  if (d.layout !== undefined) { ui.layout = !ui.layout; render(); if (!ui.layout) window.scrollTo({ top: 0 }); return; }
  if (d.hide) return change(p => {
    const set = new Set(p.hidden ?? []);
    set.has(d.hide) ? set.delete(d.hide) : set.add(d.hide);
    p.hidden = [...set];
  });
  if (d.showAll !== undefined) return change(p => { p.hidden = []; });
  if (d.slot) return change(p => togglePip(p.slotsUsed, d.slot, Number(d.i)));
  if (d.pact !== undefined) return change(p => { p.pactUsed = Number(d.i) < p.pactUsed ? Number(d.i) : Number(d.i) + 1; });
  if (d.resource) return change(p => togglePip(p.resourcesUsed, d.resource, Number(d.i)));
  if (d.featureUse) return change(p => togglePip(p.featureUses, d.featureUse, Number(d.i)));
  if (d.free) return change(p => togglePip(p.freeCastUsed, d.free, Number(d.i)));
  if (d.death) return change(p => togglePip(p.deathSaves, d.death, Number(d.i)));
  if (d.inspiration !== undefined) return change(p => { p.inspiration = !p.inspiration; });
  if (d.exh) return change(p => { p.exhaustion = clampInt((p.exhaustion ?? 0) + Number(d.exh), 0, 6); });
  if (d.hd) return change(p => { p.hitDiceSpent = clampInt(p.hitDiceSpent + Number(d.hd), 0, s.level); });
  if (d.acReset !== undefined) return change(p => { p.ac = null; });
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
      }
    });
  }
  if (d.rest) return rest(d.rest, s);
}

function rest(kind, s) {
  const msg = kind === "long"
    ? "Take a long rest? You regain all hit points, hit dice and spell slots, and one level of exhaustion."
    : "Take a short rest? Pact slots and short-rest features come back. Spend hit dice yourself to heal.";
  if (!confirm(msg)) return;
  change(p => {
    const shortOnes = s.resources.filter(r => r.recharge === "short");
    for (const r of shortOnes) p.resourcesUsed[r.id] = 0;
    for (const r of s.resources.filter(r => r.short_rest_regain)) p.resourcesUsed[r.id] = Math.max(0, (p.resourcesUsed[r.id] ?? 0) - r.short_rest_regain);
    for (const f of s.features.filter(f => f.uses?.recharge === "short")) p.featureUses[f.key] = 0;
    for (const sp of s.spells.filter(sp => sp.free_cast?.recharge === "short")) p.freeCastUsed[`${sp.id}|${sp.source}`] = 0;
    p.pactUsed = 0;
    if (kind === "long") {
      p.hp.current = s.hp ?? p.hp.current;
      p.hp.temp = 0;
      p.hitDiceSpent = 0;
      p.slotsUsed = {};
      p.resourcesUsed = {};
      p.featureUses = {};
      p.freeCastUsed = {};
      p.deathSaves = { success: 0, fail: 0 };
      p.exhaustion = Math.max(0, (p.exhaustion ?? 0) - 1);
    }
  });
}
