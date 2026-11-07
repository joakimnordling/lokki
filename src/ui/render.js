// Top-level rendering: the metric list, and dispatch to the detail and entry list views.
import { ago, esc, fmt } from "../core/format.js";
import { store } from "../core/prefs.js";
import { entriesOf, metrics, outbox, S, ui } from "../data/state.js";
import { detailRender, loadView } from "./detail.js";
import { $ } from "./dom.js";
import { entriesRender } from "./entries.js";
import { ICON } from "./icons.js";
import { openSettings } from "./settings.js";
import { openEntrySheet, openMetricSheet, openTypeFilter } from "./sheets.js";

export function render() {
  const hdr = $("#hdr"),
    main = $("#main"),
    tb = $("#toolbar");
  if (ui.view !== "list" && !metrics.has(ui.mid)) ui.view = "list";
  if (ui.view !== "entries") main.dataset.view = "";
  if (ui.view === "list") {
    hdr.innerHTML = `<button class="hbtn" id="hType" aria-label="Filter by log type">${ICON.grid}</button><h1>My Logs</h1><button class="hbtn right" id="hSet" aria-label="Preferences">${ICON.gear}</button>`;
    $("#hType").onclick = openTypeFilter;
    $("#hSet").onclick = openSettings;
    tb.hidden = true;
    main.innerHTML = listHTML();
    bindList();
  } else if (ui.view === "entries") {
    entriesRender();
  } else {
    const m = metrics.get(ui.mid);
    hdr.innerHTML = `<button class="hbtn" id="hBack">${ICON.back}<span>My Logs</span></button><h1>${esc(m.name)}</h1><button class="hbtn right" id="hEdit" aria-label="Edit metric">${ICON.edit}</button>`;
    $("#hBack").onclick = () => {
      ui.view = "list";
      render();
      window.scrollTo(0, 0);
    };
    $("#hEdit").onclick = () => openMetricSheet(ui.mid);
    tb.hidden = false;
    detailRender();
  }
}
function listHTML() {
  const { db, stale } = S;
  if (!S.localReady) return `<div class="state"><b>Loading your logs…</b></div>`;
  if (!S.local && !db && !metrics.size)
    return `<div class="state"><b>Sign in to see your logs</b>Your logs are synced through your claude.ai account. Open this page while signed in to claude.ai.</div>`;
  if (!S.remoteReady && db && !S.fullCopy)
    return `<div class="state"><b>${stale ? "Can't reach your logs yet" : "Loading your logs…"}</b>${stale ? "This device doesn't have a saved copy yet. Your logs appear as soon as it connects." : ""}</div>`;
  if (!S.local && !S.remoteReady && !metrics.size)
    return `<div class="state"><b>${stale ? "Can't reach your logs yet" : "Loading your logs…"}</b>${stale ? "Check your connection. The list fills in as soon as it connects." : ""}</div>`;
  let ms = [...metrics.entries()].map(([id, m]) => {
    const es = entriesOf(id);
    return { id, ...m, last: es[es.length - 1] };
  });
  if (ui.filter) ms = ms.filter((m) => m.type === ui.filter);
  ms.sort((a, b) => (b.last ? b.last.t : -1) - (a.last ? a.last.t : -1) || a.name.localeCompare(b.name));
  let h = `<button class="create" id="cCreate">Create Custom Metric</button>`;
  if (ui.filter)
    h += `<div class="filterbar"><span>Showing ${esc(ui.filter)}</span><button id="clrF">Show all</button></div>`;
  if (S.local) {
    if (metrics.size) h += `<div class="note">Saved on this device only. Back up from Preferences now and then.</div>`;
  } else if (!db)
    h += `<div class="note">Not syncing: open this page signed in to claude.ai. Changes are saved on this device.</div>`;
  else if (outbox.size && (S.syncErr || stale || !navigator.onLine))
    h += `<div class="note">${outbox.size === 1 ? "1 change" : `${outbox.size} changes`} saved on this device, waiting to sync.</div>`;
  else if (stale) h += `<div class="note">Can't reach the server right now. Showing what's saved on this device.</div>`;
  if (!ms.length)
    h += `<div class="state"><b>No metrics yet</b>Create a metric, or import CSV files from Preferences.</div>`;
  for (const m of ms)
    h += `<div class="row"><button class="name" data-open="${esc(m.id)}">${esc(m.name)}<span class="ago">${m.last ? ago(m.last.t) : "No Entries"}</span></button><button class="pill" data-add="${esc(m.id)}" aria-label="Add ${esc(m.name)} entry">${m.last ? fmt(m.last.v) : "+"}</button></div>`;
  return `${h}<div style="border-top:1px solid var(--line)"></div>`;
}
function bindList() {
  const c = $("#cCreate");
  if (c) c.onclick = () => openMetricSheet(null);
  const f = $("#clrF");
  if (f)
    f.onclick = () => {
      ui.filter = "";
      store.set("filter", "");
      render();
    };
  for (const b of document.querySelectorAll("[data-open]"))
    b.onclick = () => {
      ui.view = "detail";
      ui.mid = b.dataset.open;
      loadView(ui.mid);
      ui.sel = null;
      render();
      window.scrollTo(0, 0);
    };
  for (const b of document.querySelectorAll("[data-add]")) b.onclick = () => openEntrySheet(b.dataset.add, null);
}
