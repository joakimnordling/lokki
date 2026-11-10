// Lokki: wires the modules together and starts the app.

import { parseDate } from "./core/csv.js";
import { evalExpr } from "./core/expr.js";
import { uuid5 } from "./core/ids.js";
import { startOf } from "./core/periods.js";
import { applyLook, applyTextSize, store } from "./core/prefs.js";
import { stats } from "./core/stats.js";
import { idb } from "./data/idb.js";
import { addEntry, deleteEntry, deleteMetric, editEntry, restoreEntry } from "./data/records.js";
import { series } from "./data/series.js";
import { hooks, metricAll, outbox, rebuild, recs, refreshMetrics, S, ui } from "./data/state.js";
import { connectClaude, flush, flushSoon } from "./sync/claude.js";
import { sync } from "./sync/manager.js";
import { restoreFromFile } from "./ui/backup.js";
import { detailRender } from "./ui/detail.js";
import { $ } from "./ui/dom.js";
import { installEntryScroll } from "./ui/entries.js";
import { importCSVFiles, openMetricCSV } from "./ui/files.js";
import { ICON } from "./ui/icons.js";
import { render } from "./ui/render.js";
import { openDeleteMetric, openEntrySheet, toast } from "./ui/sheets.js";
import { watchForUpdates } from "./ui/update.js";

applyLook(store.get("look"));
applyTextSize(store.get("text"));
hooks.render = render;
hooks.flushSoon = flushSoon;
hooks.toast = toast;

$("#fileIn").onchange = importCSVFiles;
$("#bakIn").onchange = restoreFromFile;
$("#tbAdd").onclick = () => openEntrySheet(ui.mid, null);
$("#tbEntries").onclick = openMetricCSV;
$("#tbDelete").onclick = openDeleteMetric;
$("#tbEntries").innerHTML = ICON.csv;
$("#tbAdd").innerHTML = ICON.add;
$("#tbDelete").innerHTML = ICON.trash;
installEntryScroll();
addEventListener("resize", () => {
  if (ui.view === "detail") detailRender();
});

render();
(async () => {
  // 1. this device's copy first: the app opens with your data even offline
  await idb.open();
  try {
    navigator.storage?.persist?.();
  } catch (_e) {}
  const [lr, lm, lo] = await Promise.all([idb.all("recs"), idb.all("metrics"), idb.all("outbox")]);
  for (const r of lr) recs.set(r.id, r);
  for (const x of lm) {
    const { id, ...d } = x;
    metricAll.set(id, d);
  }
  for (const o of lo) {
    outbox.set(o.k, o);
    S.seq = Math.max(S.seq, o.seq || 0);
  }
  refreshMetrics();
  rebuild();
  S.local = !window.claude;
  const listShown = () => ui.view === "list" && !document.querySelector(".scrim");
  if (S.local) {
    // standalone: Lokki's own sync. Changes queued for claude.ai (by older versions) can never be sent from here.
    if (outbox.size) {
      const stale = [...outbox.keys()];
      outbox.clear();
      await idb.write(stale.map((k) => ["outbox", "delete", k]));
    }
    await sync.load();
    hooks.flushSoon = () => sync.soon();
    sync.onChange(() => {
      if (listShown()) render();
    });
  }
  S.localReady = true;
  render();
  // 2. then sync, and notice new versions of the standalone app
  if (S.local) {
    sync.start();
    watchForUpdates();
  } else if (!(await connectClaude(render))) return;
  setInterval(() => {
    if (listShown()) render();
  }, 60000);
})();

// Hooks for the end-to-end tests.
window.__lokki = {
  evalExpr,
  series,
  stats,
  parseDate,
  startOf,
  uuid5,
  recs,
  outbox,
  metricAll,
  sync,
  flush: () => flush(),
};
window.__test = { add: addEntry, edit: editEntry, del: deleteEntry, restore: restoreEntry, delMetric: deleteMetric };
