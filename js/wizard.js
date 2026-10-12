// The character creation wizard. All state lives in `draft`; every change re-runs the
// engine and re-renders, so what's on screen is always what the rules say.
import { resolve, summarize, emptyBuild, allDecisions, baseScores, asiIncrements, titleCase } from "./engine.js";
import { esc, md, renderGrants, makeLinker } from "./render.js";
import { ABILITIES, ABBR, ABILITY_KEYS, STANDARD_ARRAY, POINT_BUY, ALIGNMENTS, mod, signed, ordinal } from "./rules.js";

const DRAFT_KEY = "character-builder:draft";

export const STEPS = [
  { id: "class", title: "Class" },
  { id: "background", title: "Background" },
  { id: "species", title: "Species" },
  { id: "abilities", title: "Ability scores" },
  { id: "spells", title: "Spells" },
  { id: "equipment", title: "Equipment" },
  { id: "details", title: "Details" },
  { id: "review", title: "Review" },
];

// ---------- draft storage (per-browser convenience; the exported file is the real save) ----------
export function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d?.build) return { details: {}, step: "class", ...d, build: { ...emptyBuild(), ...d.build } };
    }
  } catch {}
  return null;
}
function saveDraft(draft) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {}
}
export function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}
export function hasDraft() {
  const d = loadDraft();
  return !!(d && (d.build.class || d.build.background || d.build.species));
}
export function draftLabel(pack) {
  const d = loadDraft();
  if (!d) return "";
  const cls = pack.classes?.[d.build.class]?.name;
  const name = d.details?.name?.trim();
  return [name, cls ? `level ${d.build.level} ${cls}` : null].filter(Boolean).join(", ");
}

// ---------- module state ----------
let draft = null;
let pack = null;
let root = null;
let ui = { search: {}, created: null };

export function mountWizard(el, contentPack, { fresh = false } = {}) {
  root = el;
  pack = contentPack;
  if (fresh) clearDraft();
  draft = loadDraft() ?? { build: emptyBuild(), details: {}, step: "class" };
  ui = { search: {}, created: null };
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  root.addEventListener("click", onClick);
  render();
}

export function unmountWizard() {
  if (!root) return;
  root.removeEventListener("change", onChange);
  root.removeEventListener("input", onInput);
  root.removeEventListener("click", onClick);
  root = null;
}

function update(fn) {
  fn(draft);
  draft.build.overrides = false; // any change means the DM override must be re-confirmed
  saveDraft(draft);
  render();
}

// ---------- rendering ----------
function stepStatus(res) {
  const open = new Map(STEPS.map(s => [s.id, 0]));
  for (const w of res.warnings) if (!w.info && open.has(w.step)) open.set(w.step, open.get(w.step) + 1);
  return open;
}

function render() {
  if (!root) return;
  const focusId = document.activeElement?.dataset?.focus;
  const res = resolve(draft.build, pack);
  const sum = summarize(draft.build, pack, res);
  const status = stepStatus(res);
  const visited = new Set(draft.visited ?? []);
  visited.add(draft.step);
  draft.visited = [...visited];
  const idx = STEPS.findIndex(s => s.id === draft.step);

  root.innerHTML = `
    <div class="wizard">
      <nav class="steps" aria-label="Character creation steps">
        <ol>${STEPS.map((s, i) => {
          const n = status.get(s.id);
          const state = s.id === draft.step ? "current" : n ? (visited.has(s.id) ? "open" : "todo") : visited.has(s.id) ? "done" : "todo";
          return `<li><button type="button" data-step="${s.id}" class="step-${state}" ${s.id === draft.step ? 'aria-current="step"' : ""}>
            <span class="step-num">${i + 1}</span><span class="step-title">${esc(s.title)}</span>
            ${state === "open" ? `<span class="step-flag">${n} to finish</span>` : ""}
          </button></li>`;
        }).join("")}</ol>
      </nav>
      <section class="step-body" aria-labelledby="step-heading">
        ${ui.created ? renderCreated() : renderStep(draft.step, res, sum)}
        ${ui.created ? "" : `<div class="step-nav">
          ${idx > 0 ? `<button type="button" class="btn" data-go="${STEPS[idx - 1].id}">Back to ${esc(STEPS[idx - 1].title.toLowerCase())}</button>` : "<span></span>"}
          ${idx < STEPS.length - 1 ? `<button type="button" class="btn btn-primary" data-go="${STEPS[idx + 1].id}">Next: ${esc(STEPS[idx + 1].title.toLowerCase())}</button>` : ""}
        </div>`}
      </section>
      <aside class="live-summary" aria-label="Character so far">${renderLiveSummary(sum)}</aside>
    </div>`;

  // Re-apply spell search filters and focus after the re-render.
  for (const [key, q] of Object.entries(ui.search)) filterList(key, q);
  if (focusId) {
    const el = root.querySelector(`[data-focus="${CSS.escape(focusId)}"]`);
    if (el) { el.focus(); if (el.setSelectionRange && el.type === "search") el.setSelectionRange(el.value.length, el.value.length); }
  }
}

function renderLiveSummary(s) {
  const b = draft.build;
  const cls = pack.classes?.[b.class];
  const name = draft.details.name?.trim();
  const line = [pack.species?.[b.species]?.name, cls ? `${cls.name} ${b.level}` : null].filter(Boolean).join(" ");
  return `
    <h2>${esc(name || "New character")}</h2>
    <p class="muted">${esc(line || "Nothing picked yet")}</p>
    <dl class="scores">${ABILITY_KEYS.map(a => `<div><dt>${ABBR[a]}</dt><dd><strong>${s.scores[a]}</strong><span>${signed(s.mods[a])}</span></dd></div>`).join("")}</dl>
    <dl class="vitals">
      <div><dt>Hit points</dt><dd>${s.hp ?? "—"}</dd></div>
      <div><dt>Armor class</dt><dd>${s.ac}<small> unarmored</small></dd></div>
      <div><dt>Proficiency</dt><dd>${signed(s.pb)}</dd></div>
      <div><dt>Speed</dt><dd>${s.speed} ft</dd></div>
      ${s.spellcasting ? `<div><dt>Spell save DC</dt><dd>${s.spellcasting.dc}</dd></div>` : ""}
      ${s.gold ? `<div><dt>Starting gold</dt><dd>${s.gold} GP</dd></div>` : ""}
    </dl>`;
}

function renderStep(step, res, sum) {
  switch (step) {
    case "class": return stepClass(res);
    case "background": return stepPick("background", "backgrounds", "Background", res);
    case "species": return stepPick("species", "species", "Species", res);
    case "abilities": return stepAbilities(res, sum);
    case "spells": return stepSpells(res);
    case "equipment": return stepEquipment(sum);
    case "details": return stepDetails(res);
    case "review": return stepReview(res, sum);
  }
  return "";
}

function heading(title, intro) {
  return `<h1 id="step-heading">${esc(title)}</h1>${intro ? `<p class="step-intro">${intro}</p>` : ""}`;
}

function entryCards(bucket, field, current, describe) {
  const entries = Object.entries(pack[bucket] ?? {}).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  if (!entries.length) return `<p class="muted">This content pack has no ${esc(bucket)} yet.</p>`;
  return `<div class="pick-grid" role="radiogroup" aria-label="${esc(titleCase(field))}">${entries.map(([id, e]) => `
    <label class="pick-card ${current === id ? "selected" : ""}">
      <input type="radio" name="pick-${field}" data-pick="${field}" value="${esc(id)}" ${current === id ? "checked" : ""}>
      <span class="pick-name">${esc(e.name)}${e.homebrew ? ' <span class="badge">Homebrew</span>' : ""}</span>
      <span class="pick-sub">${esc(describe(e))}</span>
    </label>`).join("")}</div>`;
}

function stepClass(res) {
  const b = draft.build;
  const cls = pack.classes?.[b.class];
  return `${heading("Class", "Your class decides your role in a fight, your hit points and most of your abilities.")}
    <div class="field-row">
      <label class="field"><span>Starting level</span>
        <select data-field="level">${Array.from({ length: 20 }, (_, i) => `<option value="${i + 1}" ${b.level === i + 1 ? "selected" : ""}>${i + 1}</option>`).join("")}</select>
      </label>
      <p class="muted field-note">Most campaigns start at level 1. Ask your DM if yours starts higher.</p>
    </div>
    ${entryCards("classes", "class", b.class, e => [e.hit_die ? `d${e.hit_die} hit die` : "", (e.primary_ability ?? []).map(a => ABILITIES[a]).join(" or ")].filter(Boolean).join(", "))}
    ${cls ? `<h2>${esc(cls.name)} choices</h2>${renderDecisions(res.decisions.class)}` : ""}`;
}

function stepPick(field, bucket, title, res) {
  const b = draft.build;
  const intros = {
    background: "Your background is what you did before adventuring. It sets your ability score increases, an origin feat, and two skills.",
    species: "Your species gives you traits like darkvision or extra speed. In the 2024 rules it doesn't change your ability scores.",
  };
  const entry = pack[bucket]?.[b[field]];
  const describe = bucket === "species"
    ? e => [e.size ? [].concat(e.size).join(" or ") : "", e.speed ? `${e.speed} ft` : ""].filter(Boolean).join(", ")
    : e => (e.grants ?? []).filter(g => g.type === "proficiency" && g.kind === "skill").flatMap(g => g.values).join(", ");
  const preview = entry
    ? `<details class="preview"><summary>Everything ${esc(entry.name)} gives you</summary>${renderGrants(entry.grants, { link: (k, id, l) => makeLinker(pack)(k, id, l).replace("<a ", '<a target="_blank" rel="noopener" '), choices: new Map(), levelWord: "Character level", subclasses: [] }) || ""}</details>`
    : "";
  return `${heading(title, intros[field])}
    ${entryCards(bucket, field, b[field], describe)}
    ${entry ? `${preview}<h2>${esc(entry.name)} choices</h2>${renderDecisions(res.decisions[field]) || `<p class="muted">Nothing to choose here.</p>`}` : ""}`;
}

// ---------- decisions ----------
function renderDecisions(list) {
  if (!list?.length) return "";
  return `<div class="decisions">${list.map(renderDecision).join("")}</div>`;
}

function decisionHead(d) {
  const pill = d.kind === "asi" ? "" : d.fixed ? `<span class="pill pill-set">set</span>` : `<span class="pill ${d.complete ? "pill-done" : ""}">${d.complete ? "done" : `choose ${d.choose}`}</span>`;
  return `<header class="decision-head"><h3>${esc(d.label)}</h3>${pill}</header>
    <p class="decision-source">From ${esc(d.source)}${d.swap === "long_rest" ? ". You can change this after a long rest" : d.swap === "level_up" ? ". You can change this when you gain a level" : ""}</p>`;
}

function renderDecision(d) {
  let body;
  if (d.kind === "asi") body = renderPointAsi(d);
  else if (d.fixed) body = `<p>${esc(d.options.find(o => o.value === d.value[0])?.label ?? titleCase(d.value[0]))}, set by ${d.step === "background" ? "your background" : d.step === "species" ? "your species" : "the feature that grants this"}.</p>`;
  else if (d.waiting) body = `<p class="muted">${esc(d.waiting)}</p>`;
  else if (!d.options.length) body = `<p class="muted">This content pack has nothing to pick here yet. Ask your DM, or add the missing notes to the content repo.</p>`;
  else if (d.kind === "subclass" || d.isNamed || d.isFeat) body = renderCards(d);
  else if (d.isSpell || d.options.length > 10) body = renderChecklist(d);
  else body = renderChips(d);
  return `<div class="decision ${d.complete ? "is-complete" : ""}" id="d-${esc(cssId(d.key))}">
    ${decisionHead(d)}${body}
    ${d.children?.length ? `<div class="decision-children">${renderDecisions(d.children)}</div>` : ""}
  </div>`;
}

// Content notes often start with their own title; the card already shows it.
const stripTitle = text => String(text).replace(/^\s*#{1,6}\s+.*\n+/, "");

const cssId = key => key.replace(/[^a-zA-Z0-9_-]/g, "_");

function inputFor(d, o) {
  const type = d.choose === 1 ? "radio" : "checkbox";
  const checked = d.value.includes(o.value);
  const full = !checked && d.choose > 1 && d.value.length >= d.choose;
  return `<input type="${type}" name="${esc(d.key)}" data-key="${esc(d.key)}" data-choose="${d.choose}" value="${esc(o.value)}" ${checked ? "checked" : ""} ${full ? "disabled" : ""}>`;
}

function renderChips(d) {
  return `<div class="chip-group">${d.options.map(o => `
    <label class="chip ${d.value.includes(o.value) ? "selected" : ""}">${inputFor(d, o)}<span>${esc(o.label)}</span></label>`).join("")}</div>
    ${d.choose > 1 ? `<p class="count">${d.value.length} of ${d.choose} chosen</p>` : ""}`;
}

function renderCards(d) {
  return `<div class="option-cards">${d.options.map(o => `
    <label class="option-card ${d.value.includes(o.value) ? "selected" : ""}">
      ${inputFor(d, o)}
      <span class="option-name">${esc(o.label)}${o.link ? ` <a href="${o.link}" target="_blank" rel="noopener" class="details-link">details</a>` : ""}</span>
      ${o.text ? `<span class="option-text">${md(stripTitle(o.text))}</span>` : ""}
      ${o.note ? `<span class="option-warn">${esc(o.note)}</span>` : ""}
    </label>`).join("")}</div>`;
}

function renderChecklist(d) {
  const q = ui.search[d.key] ?? "";
  return `
    <div class="checklist-tools">
      <label class="search"><span class="visually-hidden">Search ${esc(d.label.toLowerCase())}</span>
        <input type="search" placeholder="Search" data-search="${esc(d.key)}" data-focus="search:${esc(d.key)}" value="${esc(q)}"></label>
      <p class="count">${d.value.length} of ${d.choose} chosen</p>
    </div>
    <ul class="checklist" data-list="${esc(d.key)}">${d.options.map(o => `
      <li data-name="${esc(o.label.toLowerCase())}">
        <label class="${d.value.includes(o.value) ? "selected" : ""}">${inputFor(d, o)}
          <span class="cl-name">${esc(o.label)}</span>
          ${o.sub ? `<span class="cl-sub">${esc(o.sub)}</span>` : ""}
          ${o.note ? `<span class="cl-note">${esc(o.note)}</span>` : ""}
        </label>
        ${o.link ? `<a href="${o.link}" target="_blank" rel="noopener" class="details-link">details</a>` : ""}
      </li>`).join("")}</ul>`;
}

function renderPointAsi(d) {
  const v = d.value ?? {};
  const spent = ABILITY_KEYS.reduce((n, a) => n + (v[a] ?? 0), 0);
  const left = d.asi.points - spent;
  const res = resolve(draft.build, pack);
  const sum = summarize(draft.build, pack, res);
  return `<div class="asi-points">${ABILITY_KEYS.map(a => {
    const n = v[a] ?? 0;
    return `<div class="asi-row">
      <span class="asi-ab">${ABILITIES[a]}</span>
      <button type="button" class="step-btn" data-asi="${esc(d.key)}" data-ab="${a}" data-delta="-1" ${n <= 0 ? "disabled" : ""} aria-label="Lower ${ABILITIES[a]}">−</button>
      <span class="asi-val">${n ? `+${n}` : "0"}</span>
      <button type="button" class="step-btn" data-asi="${esc(d.key)}" data-ab="${a}" data-delta="1" ${left <= 0 || n >= d.asi.max_per_ability || sum.scores[a] >= d.asi.cap ? "disabled" : ""} aria-label="Raise ${ABILITIES[a]}">+</button>
      <span class="asi-total">${sum.scores[a]}</span>
    </div>`;
  }).join("")}</div>
  <p class="count">${left} of ${d.asi.points} point${d.asi.points === 1 ? "" : "s"} left. Scores can't go above ${d.asi.cap}.</p>`;
}

// ---------- ability scores ----------
function stepAbilities(res, sum) {
  const b = draft.build;
  const method = b.abilities.method;
  const base = baseScores(b);
  const cls = pack.classes?.[b.class];
  const bgAsi = res.decisions.abilities.find(d => d.kind === "asi" && d.asi.mode === "background");
  const otherInc = Object.fromEntries(ABILITY_KEYS.map(a => [a, 0]));
  for (const d of res.asi) {
    if (d === bgAsi || !d.value) continue;
    for (const [a, n] of Object.entries(asiIncrements(d.asi, d.value))) otherInc[a] += n;
  }
  const bgInc = bgAsi ? asiIncrements(bgAsi.asi, bgAsi.value) : {};
  const spent = ABILITY_KEYS.reduce((n, a) => n + (POINT_BUY.cost[base[a]] ?? 0), 0);

  const control = a => {
    const v = base[a];
    if (method === "standard") {
      const used = new Set(ABILITY_KEYS.filter(x => x !== a).map(x => base[x]));
      return `<select data-score="${a}" aria-label="${ABILITIES[a]} score"><option value="">—</option>${STANDARD_ARRAY.map(n =>
        `<option value="${n}" ${v === n ? "selected" : ""}>${n}${used.has(n) ? " (used)" : ""}</option>`).join("")}</select>`;
    }
    if (method === "pointbuy") {
      const cur = v ?? 8;
      const nextCost = (POINT_BUY.cost[cur + 1] ?? Infinity) - POINT_BUY.cost[cur];
      return `<span class="stepper">
        <button type="button" class="step-btn" data-pb="${a}" data-delta="-1" ${cur <= 8 ? "disabled" : ""} aria-label="Lower ${ABILITIES[a]}">−</button>
        <span class="asi-val">${cur}</span>
        <button type="button" class="step-btn" data-pb="${a}" data-delta="1" ${cur >= 15 || spent + nextCost > POINT_BUY.budget ? "disabled" : ""} aria-label="Raise ${ABILITIES[a]}">+</button>
      </span>`;
    }
    return `<input type="number" min="1" max="30" inputmode="numeric" data-score="${a}" data-focus="score:${a}" value="${v ?? ""}" aria-label="${ABILITIES[a]} score">`;
  };

  const bgControl = !bgAsi ? `<p class="muted">Pick a background first; it decides which three abilities you can raise.</p>` : (() => {
    const v = bgAsi.value ?? {};
    const abs = bgAsi.asi.abilities ?? [];
    const sel = (field, other) => `<select data-bgasi="${field}" aria-label="${field === "plus2" ? "Plus 2" : "Plus 1"}"><option value="">—</option>${abs.map(a =>
      `<option value="${a}" ${v[field] === a ? "selected" : ""} ${v[other] === a ? "disabled" : ""}>${ABILITIES[a]}</option>`).join("")}</select>`;
    return `<div class="bg-asi">
      <p>${esc(pack.backgrounds[b.background].name)} lets you raise ${abs.map(a => ABILITIES[a]).join(", ").replace(/, ([^,]*)$/, " or $1")}.</p>
      <div class="radio-row" role="radiogroup" aria-label="How to split the increase">
        <label class="chip ${v.mode === "2/1" ? "selected" : ""}"><input type="radio" name="bgasi-mode" data-bgasi="mode" value="2/1" ${v.mode === "2/1" ? "checked" : ""}><span>+2 to one, +1 to another</span></label>
        <label class="chip ${v.mode === "1/1/1" ? "selected" : ""}"><input type="radio" name="bgasi-mode" data-bgasi="mode" value="1/1/1" ${v.mode === "1/1/1" ? "checked" : ""}><span>+1 to all three</span></label>
      </div>
      ${v.mode === "2/1" ? `<div class="field-row"><label class="field"><span>+2</span>${sel("plus2", "plus1")}</label><label class="field"><span>+1</span>${sel("plus1", "plus2")}</label></div>` : ""}
    </div>`;
  })();

  return `${heading("Ability scores", cls ? `${esc(cls.name)}s rely on ${(cls.primary_ability ?? []).map(a => ABILITIES[a]).join(" or ")}. Put your highest score there.` : "")}
    <div class="radio-row method" role="radiogroup" aria-label="How to generate scores">
      ${[["standard", "Standard array"], ["pointbuy", "Point buy"], ["manual", "Rolled or manual"]].map(([id, label]) => `
        <label class="chip ${method === id ? "selected" : ""}"><input type="radio" name="method" data-method value="${id}" ${method === id ? "checked" : ""}><span>${label}</span></label>`).join("")}
    </div>
    <p class="muted">${{
      standard: "Assign 15, 14, 13, 12, 10 and 8, one to each ability.",
      pointbuy: `Every score starts at 8. You have ${POINT_BUY.budget} points; you've spent ${spent}.`,
      manual: "Roll 4d6 and drop the lowest, six times, or enter scores your DM gave you.",
    }[method]}</p>
    <table class="score-table">
      <thead><tr><th scope="col">Ability</th><th scope="col">Base</th><th scope="col">Background</th><th scope="col">Other</th><th scope="col">Score</th><th scope="col">Modifier</th></tr></thead>
      <tbody>${ABILITY_KEYS.map(a => `<tr>
        <th scope="row">${ABILITIES[a]}</th><td>${control(a)}</td>
        <td>${bgInc[a] ? `+${bgInc[a]}` : ""}</td><td>${otherInc[a] ? `+${otherInc[a]}` : ""}</td>
        <td class="score-final">${sum.scores[a]}</td><td>${signed(sum.mods[a])}</td></tr>`).join("")}</tbody>
    </table>
    <h2>Background increase</h2>${bgControl}
    ${otherInc && Object.values(otherInc).some(Boolean) ? `<p class="muted">The "Other" column comes from feats like Ability Score Improvement, chosen on the class step.</p>` : ""}`;
}

// ---------- spells ----------
function stepSpells(res) {
  const cls = pack.classes?.[draft.build.class];
  const sc = cls?.spellcasting;
  const intro = !cls ? "Choose a class first."
    : !sc || sc.progression === "none" ? `${esc(cls.name)}s don't cast spells from a class list. Spells from your species, background or feats are picked on those steps.`
    : `${esc(cls.name)}s cast with ${ABILITIES[sc.ability]}. Spells you always have prepared, like domain spells, don't count against these numbers.`;
  return `${heading("Spells", intro)}${renderDecisions(res.decisions.spells)}`;
}

// ---------- equipment ----------
function stepEquipment(sum) {
  const b = draft.build;
  const block = (field, entry) => {
    if (!entry) return `<p class="muted">Choose a ${field} first.</p>`;
    const opts = entry.starting_equipment ?? [];
    if (!opts.length) return `<p class="muted">${esc(entry.name)} doesn't list starting equipment.</p>`;
    return `<div class="option-cards">${opts.map(o => `
      <label class="option-card ${b.equipment[field] === o.label ? "selected" : ""}">
        <input type="radio" name="equip-${field}" data-equip="${field}" value="${esc(o.label)}" ${b.equipment[field] === o.label ? "checked" : ""}>
        <span class="option-name">Option ${esc(o.label)}</span>
        <span class="option-text">${o.items ? `${esc(o.items)}${o.gold ? `, plus ${o.gold} GP` : ""}` : `${o.gold ?? 0} GP to spend`}</span>
      </label>`).join("")}</div>`;
  };
  return `${heading("Equipment", "Pick a starting package from your class and your background. You'll list the actual items in the equipment box on your sheet; the builder only tracks your gold.")}
    <h2>${esc(pack.classes?.[b.class]?.name ?? "Class")}</h2>${block("class", pack.classes?.[b.class])}
    <h2>${esc(pack.backgrounds?.[b.background]?.name ?? "Background")}</h2>${block("background", pack.backgrounds?.[b.background])}
    <p class="gold-total">Starting gold: <strong>${sum.gold} GP</strong></p>`;
}

// ---------- details ----------
function stepDetails(res) {
  const d = draft.details;
  return `${heading("Details", "Name your character and pick your languages. Everything else here is optional.")}
    <div class="field-grid">
      <label class="field"><span>Character name</span><input type="text" data-detail="name" data-focus="detail:name" value="${esc(d.name ?? "")}" autocomplete="off"></label>
      <label class="field"><span>Player name</span><input type="text" data-detail="player" data-focus="detail:player" value="${esc(d.player ?? "")}" autocomplete="off"></label>
      <label class="field"><span>Alignment</span><select data-detail="alignment"><option value="">—</option>${ALIGNMENTS.map(a => `<option ${d.alignment === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
    </div>
    ${renderDecisions(res.decisions.details)}
    <label class="field field-wide"><span>Appearance and backstory</span><textarea rows="5" data-detail="backstory" data-focus="detail:backstory">${esc(d.backstory ?? "")}</textarea></label>`;
}

// ---------- review ----------
function stepReview(res, s) {
  const blocking = res.warnings.filter(w => !w.info);
  const info = res.warnings.filter(w => w.info);
  const nameMissing = !draft.details.name?.trim();
  const stepTitle = id => STEPS.find(x => x.id === id)?.title ?? "Review";
  const prof = (k) => res.proficiencies[k].map(p => p.value);
  const uniq = arr => [...new Set(arr)];
  const spellRows = s.spells.slice().sort((a, b) => (a.level ?? 99) - (b.level ?? 99) || a.name.localeCompare(b.name));

  return `${heading("Review", "Check everything over. Creating the character downloads its file; keep that file, it's your save.")}
    ${blocking.length || nameMissing ? `<div class="warn-box">
      <h2>${blocking.length + (nameMissing ? 1 : 0)} thing${blocking.length + (nameMissing ? 1 : 0) === 1 ? "" : "s"} to look at</h2>
      <ul>${nameMissing ? `<li><button type="button" class="link-btn" data-go="details">Details</button> Your character doesn't have a name yet.</li>` : ""}
        ${blocking.map(w => `<li><button type="button" class="link-btn" data-go="${w.step}">${esc(stepTitle(w.step))}</button> ${esc(w.text)}</li>`).join("")}</ul>
      <label class="override"><input type="checkbox" data-override ${draft.build.overrides ? "checked" : ""}> My DM has approved creating this character anyway</label>
    </div>` : ""}
    <div class="review-grid">
      <section><h2>Abilities</h2><table class="mini-table">${ABILITY_KEYS.map(a => `<tr><th scope="row">${ABILITIES[a]}</th><td>${s.scores[a]}</td><td>${signed(s.mods[a])}</td><td class="muted">save ${signed(s.saves.find(x => x.ability === a).bonus)}${s.saves.find(x => x.ability === a).prof ? " ●" : ""}</td></tr>`).join("")}</table></section>
      <section><h2>Combat</h2><dl class="facts compact">
        <div><dt>Hit points</dt><dd>${s.hp ?? "—"}</dd></div><div><dt>Hit dice</dt><dd>${s.level}d${s.hitDie}</dd></div>
        <div><dt>Armor class</dt><dd>${s.ac} unarmored</dd></div><div><dt>Initiative</dt><dd>${signed(s.initiative)}</dd></div>
        <div><dt>Speed</dt><dd>${s.speed} ft</dd></div><div><dt>Passive Perception</dt><dd>${s.passivePerception}</dd></div>
        ${s.darkvision ? `<div><dt>Darkvision</dt><dd>${s.darkvision} ft</dd></div>` : ""}
        ${s.spellcasting ? `<div><dt>Spell save DC</dt><dd>${s.spellcasting.dc}</dd></div><div><dt>Spell attack</dt><dd>${signed(s.spellcasting.attack)}</dd></div>` : ""}
      </dl></section>
      <section><h2>Skills</h2><ul class="skill-list">${s.skills.map(k => `<li class="${k.prof ? "prof" : ""}"><span>${esc(k.name)}${k.expertise ? " (expertise)" : ""}</span><span>${signed(k.bonus)}</span></li>`).join("")}</ul></section>
      <section><h2>Proficiencies</h2><dl class="facts compact">
        <div><dt>Armor</dt><dd>${esc(uniq(prof("armor")).join(", ") || "None")}</dd></div>
        <div><dt>Weapons</dt><dd>${esc(uniq(prof("weapon")).join(", ") || "None")}</dd></div>
        <div><dt>Tools</dt><dd>${esc(uniq(prof("tool")).join(", ") || "None")}</dd></div>
        <div><dt>Languages</dt><dd>${esc(uniq(prof("language")).join(", "))}</dd></div>
      </dl></section>
    </div>
    <h2>Features and feats</h2>
    <ul class="feature-list">${s.feats.map(f => `<li><strong>${esc(f.name)}</strong> <span class="muted">feat, from ${esc(f.source)}</span></li>`).join("")}
      ${s.features.map(f => `<li><strong>${esc(f.name)}</strong> <span class="muted">${esc(f.source)}${f.uses?.max != null ? `, ${f.uses.max} per ${f.uses.recharge === "short" ? "short rest" : "long rest"}` : ""}</span></li>`).join("")}
      ${s.resources.map(r => `<li><strong>${esc(r.name)}</strong> <span class="muted">${r.max} uses, ${esc(r.source)}</span></li>`).join("")}</ul>
    ${spellRows.length ? `<h2>Spells</h2>${s.spellcasting?.slots?.length ? `<p class="muted">Spell slots: ${s.spellcasting.slots.map((n, i) => `${n} ${ordinal(i + 1)}`).join(", ")}</p>` : ""}
      <ul class="spell-review">${spellRows.map(sp => `<li><span>${esc(sp.name)}</span><span class="muted">${esc([sp.level === 0 ? "cantrip" : sp.level ? `level ${sp.level}` : null, sp.always_prepared ? "always prepared" : null, sp.free_cast ? "free cast" : null, sp.cast_ability && sp.cast_ability !== s.spellcasting?.ability ? `${ABBR[sp.cast_ability]} (DC ${sp.dc})` : null].filter(Boolean).join(", "))}</span></li>`).join("")}</ul>` : ""}
    ${info.length ? `<details class="info-notes"><summary>${info.length} note${info.length === 1 ? "" : "s"} about missing content</summary><ul>${info.map(w => `<li>${esc(w.text)}</li>`).join("")}</ul></details>` : ""}
    <div class="create-row">
      <button type="button" class="btn btn-primary" data-create ${(blocking.length || nameMissing) && !draft.build.overrides ? "disabled" : ""}>Create character and download file</button>
      ${(blocking.length || nameMissing) && !draft.build.overrides ? `<p class="muted">Finish the items above, or tick the DM approval box.</p>` : ""}
    </div>`;
}

function renderCreated() {
  const c = ui.created;
  return `${heading(`${c.details.name || "Your character"} is ready`, "")}
    <p>Your character file, <strong>${esc(c.filename)}</strong>, was downloaded. That file is your save: keep it somewhere safe and load it each session. Nothing else is stored online.</p>
    <p>If your browser didn't download it, use the button below.</p>
    <div class="create-row">
      <button type="button" class="btn btn-primary" data-download-again>Download the file again</button>
      <button type="button" class="btn" data-start-over>Build another character</button>
    </div>`;
}

// ---------- character file ----------
function makeCharacterFile() {
  const res = resolve(draft.build, pack);
  const snapshot = {};
  for (const [bucket, ids] of Object.entries(res.sources)) {
    snapshot[bucket] = Object.fromEntries([...ids].filter(id => pack[bucket]?.[id]).map(id => [id, pack[bucket][id]]));
  }
  const now = new Date().toISOString();
  return {
    format: 1,
    kind: "character",
    id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    created: now,
    updated: now,
    pack: { version: pack.meta.version, built: pack.meta.built },
    details: { ...draft.details },
    build: structuredClone(draft.build),
    play: {},       // filled in by the sheet: current HP, used slots, equipment, notes
    snapshot,       // the content this character was built with, so pack updates don't change it
  };
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

const slug = s => (s || "character").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character";

// ---------- events ----------
function setChoice(key, value, checked, choose) {
  update(d => {
    if (key === `class.${d.build.class}/subclass`) { d.build.subclass = value; return; }
    const cur = Array.isArray(d.build.choices[key]) ? d.build.choices[key] : [];
    let next;
    if (choose === 1) next = [value];
    else if (checked) next = cur.includes(value) || cur.length >= choose ? cur : [...cur, value];
    else next = cur.filter(v => v !== value);
    d.build.choices[key] = next;
  });
}

function onChange(e) {
  const t = e.target;
  if (t.dataset.key) return setChoice(t.dataset.key, t.value, t.checked, Number(t.dataset.choose));
  if (t.dataset.pick) return update(d => { d.build[t.dataset.pick] = t.value; if (t.dataset.pick === "class") d.build.subclass = null; });
  if (t.dataset.field === "level") return update(d => { d.build.level = Number(t.value); });
  if (t.hasAttribute("data-method")) return update(d => {
    d.build.abilities.method = t.value;
    if (t.value === "pointbuy") d.build.abilities.scores = Object.fromEntries(ABILITY_KEYS.map(a => [a, Math.min(15, Math.max(8, d.build.abilities.scores[a] ?? 8))]));
    if (t.value === "standard") d.build.abilities.scores = {};
  });
  if (t.dataset.score && t.tagName === "SELECT") return update(d => {
    const v = t.value === "" ? null : Number(t.value);
    const s = d.build.abilities.scores;
    // Standard array: picking a value already used elsewhere swaps the two.
    const other = ABILITY_KEYS.find(a => a !== t.dataset.score && s[a] === v && v != null);
    if (other) s[other] = s[t.dataset.score] ?? null;
    s[t.dataset.score] = v;
  });
  if (t.dataset.score) return update(d => { d.build.abilities.scores[t.dataset.score] = t.value === "" ? null : Number(t.value); });
  if (t.dataset.bgasi) return update(d => {
    const res = resolve(d.build, pack);
    const key = res.decisions.abilities.find(x => x.kind === "asi")?.key;
    if (!key) return;
    const v = { ...(d.build.choices[key] ?? {}) };
    v[t.dataset.bgasi] = t.value || null;
    if (t.dataset.bgasi === "mode" && t.value === "1/1/1") { delete v.plus2; delete v.plus1; }
    d.build.choices[key] = v;
  });
  if (t.dataset.equip) return update(d => { d.build.equipment[t.dataset.equip] = t.value; });
  if (t.dataset.detail && t.tagName === "SELECT") return update(d => { d.details[t.dataset.detail] = t.value; });
  if (t.hasAttribute("data-override")) { draft.build.overrides = t.checked; saveDraft(draft); render(); }
}

function onInput(e) {
  const t = e.target;
  if (t.dataset.search) { ui.search[t.dataset.search] = t.value; filterList(t.dataset.search, t.value); return; }
  if (t.dataset.detail && t.tagName !== "SELECT") {
    // Typing shouldn't re-render the whole step; just save and refresh the summary name.
    draft.details[t.dataset.detail] = t.value;
    saveDraft(draft);
    if (t.dataset.detail === "name") {
      const h = root.querySelector(".live-summary h2");
      if (h) h.textContent = t.value.trim() || "New character";
    }
  }
}

function filterList(key, q) {
  const list = root?.querySelector(`[data-list="${CSS.escape(key)}"]`);
  if (!list) return;
  const needle = q.trim().toLowerCase();
  for (const li of list.children) li.hidden = !!needle && !li.dataset.name.includes(needle);
}

function onClick(e) {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.step || t.dataset.go) {
    draft.step = t.dataset.step || t.dataset.go;
    saveDraft(draft);
    render();
    root.querySelector("#step-heading")?.focus?.();
    window.scrollTo({ top: 0 });
    return;
  }
  if (t.dataset.asi) return update(d => {
    const v = { ...(d.build.choices[t.dataset.asi] ?? {}) };
    v[t.dataset.ab] = Math.max(0, (v[t.dataset.ab] ?? 0) + Number(t.dataset.delta));
    if (!v[t.dataset.ab]) delete v[t.dataset.ab];
    d.build.choices[t.dataset.asi] = v;
  });
  if (t.dataset.pb) return update(d => {
    const s = d.build.abilities.scores;
    s[t.dataset.pb] = Math.min(15, Math.max(8, (s[t.dataset.pb] ?? 8) + Number(t.dataset.delta)));
  });
  if (t.hasAttribute("data-create")) {
    const file = makeCharacterFile();
    const filename = `${slug(file.details.name)}.character.json`;
    downloadJson(file, filename);
    ui.created = { file, filename, details: file.details };
    clearDraft();
    render();
    window.scrollTo({ top: 0 });
    return;
  }
  if (t.hasAttribute("data-download-again")) return downloadJson(ui.created.file, ui.created.filename);
  if (t.hasAttribute("data-start-over")) {
    draft = { build: emptyBuild(), details: {}, step: "class" };
    ui = { search: {}, created: null };
    saveDraft(draft);
    render();
  }
}
