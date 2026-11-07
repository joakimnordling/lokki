/* CSV: simple, for spreadsheets and the old Loggr files
     per metric:  Date,Value,Note          everything:  Metric,Date,Value,Note
   Date is local time "2026-11-02 08:00:00". Import matches entries by content (metric, date/time, value);
   it also reads the old Loggr app's files ("2026-11-2 8:00:00 AM, 3", no header). */
import { toLocalStr } from "./format.js";
import { normName, sameName } from "./names.js";

export const csvq = (x) => {
  const s = x == null ? "" : String(x);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function parseCSVLine(line) {
  const r = [];
  let cur = "",
    q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      r.push(cur);
      cur = "";
    } else cur += c;
  }
  r.push(cur);
  return r.map((s) => s.trim());
}
export function parseDate(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(s.trim());
  if (!m) return null;
  let h = +m[4];
  if (m[7]) {
    h = (h % 12) + (m[7].toUpperCase() === "PM" ? 12 : 0);
  }
  const d = new Date(+m[1], +m[2] - 1, +m[3], h, +m[5], +(m[6] || 0));
  return Number.isNaN(+d) ? null : toLocalStr(d);
}
export function readCSV(text, fallbackName, onlyName) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  let bad = 0;
  const hasHead = /^(metric,)?date,value/.test((lines[0] || "").toLowerCase().replace(/\s/g, ""));
  const cols = hasHead ? parseCSVLine(lines[0]).map((c) => c.toLowerCase()) : ["date", "value", "note"];
  const at = (n) => cols.indexOf(n);
  for (const l of lines.slice(hasHead ? 1 : 0)) {
    const c = parseCSVLine(l),
      g = (n) => (at(n) < 0 ? "" : (c[at(n)] ?? ""));
    const name = normName(at("metric") >= 0 ? g("metric") : fallbackName);
    if (onlyName && !sameName(name, onlyName)) continue;
    const s = parseDate(g("date")),
      v = parseFloat(String(g("value")).replace(",", "."));
    if (!name || !s || !Number.isFinite(v)) {
      bad++;
      continue;
    }
    rows.push({ name, s, v, n: g("note") });
  }
  return { rows, bad };
}
// Old Loggr export file names encode non-ASCII characters as #U00e4.
export const decodeLoggrName = (fname) =>
  fname.replace(/\.csv$/i, "").replace(/#U([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
