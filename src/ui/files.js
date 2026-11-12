// CSV export, and saving files. Importing is in importer.js.
import { csvq } from "../core/csv.js";
import { esc, fileStamp } from "../core/format.js";
import { safeFile } from "../core/names.js";
import { entriesOf, metrics, ui } from "../data/state.js";
import { $ } from "./dom.js";
import { pickFiles } from "./importer.js";
import { toast } from "./sheets.js";

const MIME = { zip: "application/zip", csv: "text/csv", txt: "text/plain" };
// The share sheet where it can take files (iPhone: Save to Files), otherwise an ordinary download.
async function saveLocally(filename, data, what) {
  const file = new File([data], filename, { type: MIME[filename.split(".").pop()] || "application/octet-stream" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (e) {
      if (e?.name === "AbortError") return false; // closed the share sheet
      // NotAllowedError: the tap is too long ago (compressing a big backup takes a moment); download instead
    }
  }
  try {
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  } catch (e) {
    toast(`${what} didn't finish: ${e?.message || "unknown error"}.`);
    return false;
  }
}

export function saveFile(filename, data, what = "Export") {
  return saveLocally(filename, data, what);
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
  return saveFile(`lokki-export-${fileStamp()}.csv`, out);
}
// The ↓↑ button on a metric: import into or export that metric.
export function openMetricCSV() {
  const mid = ui.mid,
    m = metrics.get(mid),
    n = entriesOf(mid).length;
  const L = $("#layer");
  L.innerHTML = `<div class="scrim gut" id="scrim"><div class="actions" role="dialog" aria-modal="true" aria-label="Import or export ${esc(m.name)}">
    <div class="grp"><small>${esc(m.name)} · ${n} entries</small><button id="aImp">Import From File</button><button id="aExp">Export To CSV</button></div>
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
    pickFiles(mid);
  };
}
