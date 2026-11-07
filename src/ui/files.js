// CSV export and import, and saving files through the downloads capability.
import { csvq, decodeLoggrName, readCSV } from "../core/csv.js";
import { esc, toLocalStr } from "../core/format.js";
import { uuid4, uuid5 } from "../core/ids.js";
import { safeFile } from "../core/names.js";
import { commitRecs, fail, nextU, saveMetric } from "../data/records.js";
import { entriesOf, findMetricByName, metrics, rebuild, recs, S, ui } from "../data/state.js";
import { $ } from "./dom.js";
import { render } from "./render.js";
import { toast } from "./sheets.js";

let importTarget = null;

export async function saveFile(filename, data, what = "Export") {
  if (!S.dl) {
    toast("Downloads aren't available here.");
    return false;
  }
  try {
    await S.dl.save({ filename, data });
    return true;
  } catch (e) {
    const c = e?.code;
    if (c === "declined" || c === "cancelled") return false;
    const why =
      {
        rejected_extension: "this file type can't be saved here",
        extension_not_enabled: "this file type can't be saved here",
        too_large: "the file is too large",
        rate_limited: "another save is still open. Try again in a moment",
        unavailable: "saving isn't available in this view",
      }[c] || (c ? `error: ${c}` : "unknown error");
    toast(`${what} didn't finish: ${why}.`);
    return false;
  }
}
export function exportMetric(mid) {
  const m = metrics.get(mid);
  return saveFile(
    `${safeFile(m.name)}.csv`,
    "Date,Value,Note\n" +
      entriesOf(mid)
        .map((e) => `${e.s.replace("T", " ")},${e.v},${csvq(e.n)}\n`)
        .join(""),
  );
}
export function exportAll() {
  let out = "Metric,Date,Value,Note\n";
  for (const [id, m] of [...metrics.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)))
    for (const e of entriesOf(id)) out += `${csvq(m.name)},${e.s.replace("T", " ")},${e.v},${csvq(e.n)}\n`;
  return saveFile(`lokki-export-${toLocalStr(new Date()).slice(0, 10)}.csv`, out);
}
// The ↓↑ button on a metric: import into or export that metric.
export function openMetricCSV() {
  const mid = ui.mid,
    m = metrics.get(mid),
    n = entriesOf(mid).length;
  const L = $("#layer");
  L.innerHTML = `<div class="scrim gut" id="scrim"><div class="actions" role="dialog" aria-modal="true" aria-label="Import or export ${esc(m.name)}">
    <div class="grp"><small>${esc(m.name)} · ${n} entries</small><button id="aImp">Import From CSV</button><button id="aExp">Export To CSV</button></div>
    <button class="cancel" id="aCan">Cancel</button></div></div>`;
  const close = () => {
    L.innerHTML = "";
  };
  $("#aCan").onclick = close;
  $("#scrim").onclick = (e) => {
    if (e.target.id === "scrim") close();
  };
  $("#aExp").onclick = () => {
    close();
    exportMetric(mid);
  };
  $("#aImp").onclick = () => {
    close();
    importTarget = mid;
    const f = $("#fileIn");
    f.value = "";
    f.click();
  };
}
export async function importCSVFiles(ev) {
  const target = importTarget && metrics.get(importTarget);
  importTarget = null;
  const files = [...ev.target.files];
  if (!files.length) return;
  const byName = new Map();
  let bad = 0;
  for (const f of files) {
    const fname = target ? target.name : decodeLoggrName(f.name);
    const r = readCSV(await f.text(), fname, target?.name);
    bad += r.bad;
    for (const row of r.rows) {
      const name = target ? target.name : row.name;
      const k = name.toLowerCase();
      if (!byName.has(k)) byName.set(k, { name, list: [] });
      byName.get(k).list.push(row);
    }
  }
  if (!byName.size) {
    toast("No entries found in those files.");
    return;
  }
  let added = 0;
  toast("Importing…");
  try {
    const fresh = [];
    for (const { name, list } of byName.values()) {
      let mid = target
        ? importTarget || [...metrics.entries()].find(([, m]) => m === target)?.[0]
        : findMetricByName(name);
      if (!mid) {
        mid = uuid4();
        await saveMetric(mid, { name, type: "", created: list.reduce((a, r) => (a && a < r.s ? a : r.s), "") });
      }
      const have = new Map();
      for (const e of entriesOf(mid)) {
        const k = `${e.s}|${String(e.v)}`;
        have.set(k, (have.get(k) || 0) + 1);
      }
      const occ = new Map();
      list.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
      for (const r of list) {
        const k = `${r.s}|${String(r.v)}`,
          i = occ.get(k) || 0;
        occ.set(k, i + 1);
        if (i < (have.get(k) || 0)) continue; // already have this one
        const id = await uuid5(`${mid}|${r.s}|${String(r.v)}|${i}`);
        if (recs.has(id)) continue; // known here (maybe since edited or deleted): a CSV never overrides that
        fresh.push({ id, m: mid, y: +r.s.slice(0, 4), t: r.s, v: r.v, ...(r.n ? { n: r.n } : {}), u: nextU() });
        added++;
      }
    }
    if (fresh.length) await commitRecs(fresh);
    toast(
      `${added ? `Imported ${added} ${added === 1 ? "entry" : "entries"}` : "Nothing new to import"}${bad ? ` · skipped ${bad} unreadable ${bad === 1 ? "line" : "lines"}` : ""}`,
    );
  } catch (e) {
    rebuild();
    render();
    fail(e);
  }
}
