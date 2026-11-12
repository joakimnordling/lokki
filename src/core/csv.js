/* CSV export, and old Loggr file names. Lokki writes
     per metric:  Date,Value,Note          everything:  Metric,Date,Value,Note
   with dates in local time "2026-11-02 08:00:00". Reading CSV files (these and others) is in table.js. */
import { toLocalStr } from "./format.js";

export const csvq = (x) => {
  const s = x == null ? "" : String(x);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
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
// Old Loggr export file names encode non-ASCII characters as #U00e4.
export const decodeLoggrName = (fname) =>
  fname.replace(/\.csv$/i, "").replace(/#U([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
