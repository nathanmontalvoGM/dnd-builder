import { getPack, savePack, removePack } from "./store.js";
import { KINDS, renderEntry, listSecondary, esc, titleCase, spellLevelLabel } from "./render.js";
import { mountWizard, mountLevelUp, unmountWizard, hasDraft, draftLabel } from "./wizard.js";
import { mountSheet, unmountSheet, setSheetPack, validateCharacter, openCharacter, restoreCharacter, currentCharacter, hasUnsavedChanges } from "./sheet.js";

const SUPPORTED_FORMAT = 1;
const $ = sel => document.querySelector(sel);
const app = $("#app");

let pack = null;
const filters = {}; // per kind: { q, level, list, category }

// ---------- routing: #/<kind>/<id> ----------
function route() {
  const [, kindPath, id] = location.hash.split("/");
  const kind = KINDS.find(k => k.path === kindPath);
  return { kind, id: id ? decodeURIComponent(id) : null };
}

// ---------- toasts ----------
let toastTimer;
function toast(msg, kind = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.dataset.kind = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === "error" ? 8000 : 4000);
}

// ---------- loading a pack ----------
function validatePack(data) {
  if (!data || typeof data !== "object" || !data.meta) return "This file isn't a content pack. Ask your DM for the content.json file made by npm run build.";
  if (data.meta.format > SUPPORTED_FORMAT) return "This pack was made for a newer version of the builder. Refresh the page to update, then try again.";
  if (data.meta.format !== SUPPORTED_FORMAT) return "This pack's format isn't recognized.";
  return null;
}

async function loadFile(file) {
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { toast(`${file.name} isn't valid JSON. Pick a content.json or a .character.json file.`, "error"); return; }

  if (data?.kind === "character") return loadCharacter(data);
  const problem = validatePack(data);
  if (problem) { toast(problem, "error"); return; }

  if (pack && data.meta.built < pack.meta.built) {
    const ok = confirm(`This pack (${data.meta.version}) is older than the one you have (${pack.meta.version}). Load it anyway?`);
    if (!ok) return;
  }
  try { await savePack(data); }
  catch { toast("The pack loaded but couldn't be saved in this browser, so you'll need to load it again next visit. Private browsing windows block saving.", "error"); }
  pack = data;
  setSheetPack(pack);
  if (sheetMounted) { unmountSheet(); sheetMounted = false; }
  if (wizardMounted) { unmountWizard(); wizardMounted = false; } // remount against the new pack
  toast(`Loaded content pack ${data.meta.version}`);
  render();
}

function loadCharacter(data) {
  const problem = validateCharacter(data);
  if (problem) { toast(problem, "error"); return; }
  const open = currentCharacter();
  if (open && hasUnsavedChanges() && open.id !== data.id &&
      !confirm(`${open.details?.name || "Your open character"} has changes that aren't saved to a file yet. Open ${data.details?.name || "this character"} anyway?`)) return;
  if (open && open.id === data.id && hasUnsavedChanges() &&
      !confirm("This replaces the open copy of this character, including changes you haven't saved. Continue?")) return;
  openCharacter(data);
  if (sheetMounted) { unmountSheet(); sheetMounted = false; }
  toast(`Opened ${data.details?.name || "character"}`);
  if (location.hash === "#/sheet") render(); else location.hash = "#/sheet";
}

// ---------- views ----------
function renderEmpty() {
  $("#pack-status").hidden = true;
  $("#topnav").hidden = true;
  app.innerHTML = `
    <section class="empty">
      <h1>Load your content pack</h1>
      <p>Your DM shares a file called <strong>content.json</strong> with all the classes, species, feats and spells for your game. You only need to load it once; this browser keeps it until you replace it.</p>
      <button type="button" class="btn btn-primary" id="btn-load-empty">Choose content.json</button>
      <p class="hint">Or drag the file anywhere onto this page.</p>
      <h2 class="empty-sub">Just playing tonight?</h2>
      <p>You can open your <strong>.character.json</strong> file without a content pack. You'll need the pack to build a new character.</p>
      <button type="button" class="btn" id="btn-open-char-empty">Open a character file</button>
    </section>`;
  $("#btn-open-char-empty").addEventListener("click", () => $("#file-input").click());
  if (currentCharacter()) {
    $("#topnav").hidden = false;
    $("#nav-sheet").hidden = false;
    $("#nav-sheet").textContent = currentCharacter().details?.name || "Character sheet";
    for (const el of document.querySelectorAll("#topnav a[data-needs-pack]")) el.hidden = true;
  }
  $("#btn-load-empty").addEventListener("click", () => $("#file-input").click());
}

function packLabel() {
  const built = new Date(pack.meta.built);
  const when = isNaN(built) ? "" : built.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `Content pack ${pack.meta.version}${when ? `, built ${when}` : ""}`;
}

function sortedEntries(kindKey) {
  const items = Object.entries(pack[kindKey] ?? {}).map(([id, e]) => ({ id, ...e }));
  if (kindKey === "spells") return items.sort((a, b) => (a.level - b.level) || a.name.localeCompare(b.name));
  return items.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

function filterControls(kind) {
  const f = filters[kind.key] ??= {};
  let extra = "";
  if (kind.key === "spells") {
    const lists = [...new Set(Object.values(pack.spells ?? {}).flatMap(s => [].concat(s.lists ?? [])))].sort();
    const levels = [...new Set(Object.values(pack.spells ?? {}).map(s => s.level))].sort((a, b) => a - b);
    extra = `
      <label><span>Level</span><select data-filter="level"><option value="">Any</option>${levels.map(l => `<option value="${l}" ${String(f.level) === String(l) ? "selected" : ""}>${spellLevelLabel(l)}</option>`).join("")}</select></label>
      <label><span>List</span><select data-filter="list"><option value="">Any</option>${lists.map(l => `<option value="${esc(l)}" ${f.list === l ? "selected" : ""}>${esc(titleCase(l))}</option>`).join("")}</select></label>`;
  } else if (kind.key === "feats") {
    const cats = [...new Set(Object.values(pack.feats ?? {}).map(x => x.category))].sort();
    extra = `<label><span>Category</span><select data-filter="category"><option value="">Any</option>${cats.map(c => `<option value="${esc(c)}" ${f.category === c ? "selected" : ""}>${esc(titleCase(c))}</option>`).join("")}</select></label>`;
  }
  return `<div class="filters">
    <label class="search"><span class="visually-hidden">Search ${esc(kind.many.toLowerCase())}</span>
      <input type="search" data-filter="q" placeholder="Search ${esc(kind.many.toLowerCase())}" value="${esc(f.q ?? "")}" autocomplete="off"></label>
    ${extra ? `<div class="filter-row">${extra}</div>` : ""}
  </div>`;
}

function listItems(kind, activeId) {
  const f = filters[kind.key] ?? {};
  const q = (f.q ?? "").trim().toLowerCase();
  const items = sortedEntries(kind.key).filter(e =>
    (!q || (e.name ?? e.id).toLowerCase().includes(q)) &&
    (f.level === undefined || f.level === "" || String(e.level) === String(f.level)) &&
    (!f.list || [].concat(e.lists ?? []).includes(f.list)) &&
    (!f.category || e.category === f.category));
  if (!items.length) {
    const total = Object.keys(pack[kind.key] ?? {}).length;
    return `<p class="list-empty">${total ? "Nothing matches. Clear the search or filters to see everything." : `This pack has no ${esc(kind.many.toLowerCase())} yet.`}</p>`;
  }
  return `<ul class="entry-list">${items.map(e => `
    <li><a href="#/${kind.path}/${encodeURIComponent(e.id)}" ${e.id === activeId ? 'aria-current="page"' : ""}>
      <span class="name">${esc(e.name ?? e.id)}${e.homebrew ? ' <span class="badge">Homebrew</span>' : ""}</span>
      <span class="sub">${esc(listSecondary(kind.key, e, pack))}</span>
    </a></li>`).join("")}</ul>`;
}

function renderBrowser() {
  let { kind, id } = route();
  if (!kind) {
    kind = KINDS.find(k => Object.keys(pack[k.key] ?? {}).length) ?? KINDS[0];
    history.replaceState(null, "", `#/${kind.path}`);
  }

  const entry = id ? pack[kind.key]?.[id] : null;
  const detail = entry
    ? renderEntry(kind.key, { id, ...entry }, pack)
    : id
      ? `<div class="detail-empty"><p>There's no ${esc(kind.one.toLowerCase())} called “${esc(id)}” in this pack. It may have been renamed or removed in a newer pack.</p></div>`
      : `<div class="detail-empty"><p>Pick a ${esc(kind.one.toLowerCase())} from the list to read it.</p></div>`;

  app.innerHTML = `
    <nav class="kind-tabs" aria-label="Content type">${KINDS.map(k => `
      <a href="#/${k.path}" ${k === kind ? 'aria-current="page"' : ""}>${esc(k.many)}<span class="count">${Object.keys(pack[k.key] ?? {}).length}</span></a>`).join("")}
    </nav>
    <div class="browser ${id ? "has-detail" : ""}">
      <aside class="list-pane" aria-label="${esc(kind.many)}">
        ${filterControls(kind)}
        <div id="list">${listItems(kind, id)}</div>
      </aside>
      <div class="detail-pane">
        ${id ? `<a class="back" href="#/${kind.path}">All ${esc(kind.many.toLowerCase())}</a>` : ""}
        ${detail}
      </div>
    </div>`;

  app.querySelectorAll("[data-filter]").forEach(el => {
    const ev = el.tagName === "INPUT" ? "input" : "change";
    el.addEventListener(ev, () => {
      filters[kind.key][el.dataset.filter] = el.value;
      $("#list").innerHTML = listItems(kind, id);
    });
  });
}

function renderHome() {
  const draft = hasDraft() ? draftLabel(pack) : "";
  app.innerHTML = `
    <section class="home">
      <h1>What are you working on?</h1>
      <div class="home-actions">
        ${draft ? `<a class="home-card" href="#/new"><strong>Continue your character</strong><span>${esc(draft || "Your unfinished character")}</span></a>` : ""}
        <a class="home-card" href="${draft ? "#/new/fresh" : "#/new"}"><strong>${draft ? "Start a different character" : "Build a character"}</strong><span>Class, background, species, ability scores, spells and gear, one step at a time.</span></a>
        ${currentCharacter() ? `<a class="home-card" href="#/sheet"><strong>Back to ${esc(currentCharacter().details?.name || "your character")}</strong><span>${hasUnsavedChanges() ? "Has changes you haven't saved to a file yet." : "Open on this browser."}</span></a>` : ""}
        <button type="button" class="home-card" id="btn-open-char"><strong>Open a character file</strong><span>Load a .character.json to play from its sheet.</span></button>
        <a class="home-card" href="#/classes"><strong>Browse the compendium</strong><span>Read every class, species, background, feat and spell in your content pack.</span></a>
      </div>
    </section>`;
  $("#btn-open-char").addEventListener("click", () => $("#file-input").click());
}

function setChrome(section) {
  $("#pack-status").hidden = !pack;
  if (pack) $("#pack-version").textContent = packLabel();
  $("#topnav").hidden = false;
  const char = currentCharacter();
  const sheetLink = $("#nav-sheet");
  sheetLink.hidden = !char;
  if (char) sheetLink.textContent = char.details?.name || "Character sheet";
  for (const a of document.querySelectorAll("#topnav a[data-needs-pack]")) a.hidden = !pack;
  for (const a of document.querySelectorAll("#topnav a")) {
    if (a.dataset.nav === section) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

let wizardMounted = false; // false | "create" | "levelup"
let sheetMounted = false;
function render() {
  const hash = location.hash || "#/";
  if (hash === "#/sheet" && currentCharacter()) {
    if (wizardMounted) { unmountWizard(); wizardMounted = false; }
    setChrome("sheet");
    if (!sheetMounted) { mountSheet(app); sheetMounted = true; }
    return;
  }
  if (sheetMounted) { unmountSheet(); sheetMounted = false; }
  if (!pack) { if (wizardMounted) { unmountWizard(); wizardMounted = false; } renderEmpty(); return; }
  if (hash === "#/levelup") {
    const char = currentCharacter();
    if (!char) { history.replaceState(null, "", "#/"); render(); return; }
    setChrome("sheet");
    if (wizardMounted !== "levelup") { if (wizardMounted) unmountWizard(); mountLevelUp(app, pack, char); wizardMounted = "levelup"; }
    return;
  }
  if (hash.startsWith("#/new")) {
    setChrome("new");
    const fresh = hash === "#/new/fresh";
    if (fresh) history.replaceState(null, "", "#/new");
    if (wizardMounted !== "create" || fresh) { if (wizardMounted) unmountWizard(); mountWizard(app, pack, { fresh }); wizardMounted = "create"; }
    return;
  }
  if (wizardMounted) { unmountWizard(); wizardMounted = false; }
  if (hash === "#/" || hash === "#") { setChrome("home"); renderHome(); return; }
  setChrome("compendium");
  renderBrowser();
}

// ---------- wiring ----------
$("#file-input").addEventListener("change", e => { loadFile(e.target.files[0]); e.target.value = ""; });
$("#btn-load").addEventListener("click", () => $("#file-input").click());
$("#btn-remove").addEventListener("click", async () => {
  if (!confirm("Remove the content pack from this browser? Your exported character files aren't affected.")) return;
  await removePack().catch(() => {});
  pack = null;
  setSheetPack(null);
  history.replaceState(null, "", "#/");
  toast("Content pack removed");
  render();
});

window.addEventListener("open-character", e => loadCharacter(e.detail));

// Level Up finished: replace the open character with the levelled copy, unsaved until they save the file.
window.addEventListener("levelled-up", e => {
  openCharacter(e.detail, { dirty: true });
  if (wizardMounted) { unmountWizard(); wizardMounted = false; }
  if (sheetMounted) { unmountSheet(); sheetMounted = false; }
  toast(`${e.detail.details?.name || "Your character"} is now level ${e.detail.build.level}. Save the file to keep it.`);
  location.hash = "#/sheet";
});

window.addEventListener("hashchange", () => {
  if (!pack && location.hash !== "#/sheet") { render(); return; }
  if (location.hash === "#/sheet" && sheetMounted) return;
  if (location.hash.startsWith("#/new") && wizardMounted === "create" && location.hash !== "#/new/fresh") return;
  if (location.hash === "#/levelup" && wizardMounted === "levelup") return;
  render();
  document.querySelector(".detail-pane")?.scrollTo?.(0, 0);
  window.scrollTo(0, 0);
});

// Drag and drop anywhere on the page.
let dragDepth = 0;
const overlay = $("#drop-overlay");
const hasFile = e => [...(e.dataTransfer?.types ?? [])].includes("Files");
window.addEventListener("dragenter", e => { if (!hasFile(e)) return; e.preventDefault(); dragDepth++; overlay.hidden = false; });
window.addEventListener("dragover", e => { if (hasFile(e)) e.preventDefault(); });
window.addEventListener("dragleave", e => { if (!hasFile(e)) return; if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
window.addEventListener("drop", e => {
  if (!hasFile(e)) return;
  e.preventDefault(); dragDepth = 0; overlay.hidden = true;
  loadFile(e.dataTransfer.files[0]);
});

pack = await getPack();
if (pack && validatePack(pack)) pack = null;
setSheetPack(pack);
restoreCharacter();
render();
