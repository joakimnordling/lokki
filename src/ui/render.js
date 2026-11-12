// Top-level rendering: the metric list, and dispatch to the detail and entry list views.

import { DEMO } from "../core/demo.js";
import { ago, esc, fmt } from "../core/format.js";
import { store } from "../core/prefs.js";
import { closeDemo } from "../data/demo.js";
import { entriesOf, metrics, S, ui } from "../data/state.js";
import { sync } from "../sync/manager.js";
import { detailRender, loadView } from "./detail.js";
import { $ } from "./dom.js";
import { entriesRender } from "./entries.js";
import { ICON } from "./icons.js";
import { pickFiles } from "./importer.js";
import { openSettings } from "./settings.js";
import { openEntrySheet, openMetricSheet, openTypeFilter } from "./sheets.js";

export function render() {
  const hdr = $("#hdr"),
    main = $("#main"),
    tb = $("#toolbar");
  if (ui.view !== "list" && !metrics.has(ui.mid)) ui.view = "list";
  if (ui.view !== "entries") main.dataset.view = "";
  if (ui.view === "list") {
    const state = sync.headerState();
    const dot = state ? `<span class="dot${state === "bad" ? " bad" : ""}"></span>` : "";
    const label =
      state === "bad"
        ? "Preferences (sync has a problem)"
        : state
          ? "Preferences (changes waiting to sync)"
          : "Preferences";
    hdr.innerHTML = `<button class="hbtn" id="hType" aria-label="Filter by log type">${ICON.grid}</button><h1>My Logs</h1><button class="hbtn right" id="hSet" aria-label="${label}">${ICON.gear}${dot}</button>`;
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
  if (!S.localReady) return `<div class="state"><b>Loading your logs…</b></div>`;
  let ms = [...metrics.entries()].map(([id, m]) => {
    const es = entriesOf(id);
    return { id, ...m, last: es[es.length - 1] };
  });
  if (ui.filter) ms = ms.filter((m) => m.type === ui.filter);
  ms.sort((a, b) => (b.last ? b.last.t : -1) - (a.last ? a.last.t : -1) || a.name.localeCompare(b.name));
  // One button for it: at the top once there are metrics, in the middle of the empty screen before that
  let h = metrics.size ? `<button class="create" id="cCreate">${ICON.add}Create New Metric</button>` : "";
  if (ui.filter)
    h += `<div class="filterbar"><span>Showing ${esc(ui.filter)}</span><button id="clrF">Show all</button></div>`;
  if (DEMO)
    h += `<div class="note demo">Demo: a year of made-up logs. Your own logs and preferences aren't touched.
      <span class="demobtns"><button id="dAgain">Start Over</button><button id="dClose">Close Demo</button></span></div>`;
  else if (metrics.size && !sync.vault)
    h += `<div class="note">Saved on this device only. Back up from Preferences now and then, or set up sync.</div>`;
  if (!metrics.size)
    h += `<div class="state"><b>No metrics yet</b><button class="create mid" id="cCreate">${ICON.add}Create New Metric</button>
      <p>Kept logs in a spreadsheet or another app?</p><button class="plain trydemo" id="cImport">Import from File</button>${
        DEMO
          ? ""
          : `<b class="new">New to Lokki?</b><button class="plain trydemo" id="cDemo">Try with Demo Data</button>
      <p>The made-up logs and preferences are kept separate from yours and reset every time you open the demo.</p>`
      }</div>`;
  else if (!ms.length) h += `<div class="state">No metrics with this log type.</div>`;
  for (const m of ms)
    h += `<div class="row"><button class="name" data-open="${esc(m.id)}">${esc(m.name)}<span class="ago">${m.last ? ago(m.last.t) : "No Entries"}</span></button><button class="pill" data-add="${esc(m.id)}" aria-label="Add ${esc(m.name)} entry">${m.last ? fmt(m.last.v) : "+"}</button></div>`;
  return ms.length ? `${h}<div style="border-top:1px solid var(--line)"></div>` : h;
}
function bindList() {
  const c = $("#cCreate");
  if (c) c.onclick = () => openMetricSheet(null);
  const imp = $("#cImport");
  if (imp) imp.onclick = () => pickFiles();
  const demo = $("#cDemo");
  if (demo) demo.onclick = () => location.assign("?demo");
  const again = $("#dAgain");
  if (again) again.onclick = () => location.reload();
  const close = $("#dClose");
  if (close) close.onclick = closeDemo;
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
