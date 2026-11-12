/* Reading logs out of a table: a CSV file as people actually have them (any of , ; or tab between columns, a header
   row or none, dates as 2026-11-02, 2.11.2026, 11/2/2026 or Nov 2, 2026, with or without a time, decimal commas),
   and later spreadsheets. A table is rows of cells; a cell is a string, or already a number or Date when the file
   format says so.

   What comes out is one group per metric: a sheet with a date column and number columns ("wide") gives a group per
   number column, named after its header; a sheet with a Metric column ("long", like Lokki's own export) gives a group
   per metric named in it. Without a header row the name comes from the file. */
import { toLocalStr } from "./format.js";
import { normName } from "./names.js";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NOTE_HEADERS = /^(notes?|comments?|kommentti|huom(autus|io)?|muistiinpano|anteckning)$/i;
const TIME_HEADERS = /^(time|klo|kellonaika|aika|tid|kl)$/i;

// ---- Splitting text into rows ----

/** Cells of a CSV text, split by `delim`; quoted fields may hold the delimiter, quotes and line breaks. */
export function splitCSV(text, delim) {
  const rows = [];
  let row = [],
    cur = "",
    q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"' && cur.trim() === "") {
      cur = "";
      q = true;
    } else if (c === delim) {
      row.push(cur.trim());
      cur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur.trim());
      rows.push(row);
      row = [];
      cur = "";
    } else cur += c;
  }
  if (cur.trim() || row.length) {
    row.push(cur.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ""));
}

/** The text's column separator: tab, semicolon or comma, whichever splits its lines into the same number of columns. */
export function guessDelimiter(text) {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 50);
  for (const d of ["\t", ";", ","]) {
    const counts = splitCSV(lines.join("\n"), d).map((r) => r.length);
    if (!counts.length) continue;
    const mode = Math.max(...counts);
    if (mode > 1 && counts.filter((n) => n >= 2).length >= counts.length * 0.8) return d;
  }
  return ",";
}

/** A CSV file's text as rows of cells. */
export function csvRows(text) {
  const t = text.replace(/^﻿/, "");
  const delim = guessDelimiter(t);
  let rows = splitCSV(t, delim);
  // The old Loggr app wrote decimal commas without quotes: "2026-11-3 8:00:00 AM, 2,5"
  if (delim === ",")
    rows = rows.map((r) =>
      r.length === 3 && /^\d+$/.test(r[1]) && /^\d+$/.test(r[2]) ? [r[0], `${r[1]},${r[2]}`] : r,
    );
  return rows;
}

// ---- Numbers ----

/** A cell as a number: decimal comma or point, thousands separators, a unit after it ("5 km", "79,4 kg"); else null. */
export function parseNumber(cell) {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  if (cell == null || cell instanceof Date) return null;
  let s = String(cell)
    .trim()
    .replace(/[\s  ']/g, "")
    .replace(/^−/, "-");
  const m = /^([-+]?[\d.,]*\d)(?:[a-zA-Z%°µ/²³]{1,5})?$/.exec(s);
  if (!m) return null;
  s = m[1];
  const lastC = s.lastIndexOf(","),
    lastP = s.lastIndexOf(".");
  if (lastC >= 0 && lastP >= 0) {
    // both: the later one is the decimal mark
    s = lastC > lastP ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastC >= 0) {
    s = s.match(/,/g).length > 1 ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// ---- Dates and times ----

const pad = (n) => String(n).padStart(2, "0");
const TIME = String.raw`(\d{1,2})[:.](\d{2})(?:[:.](\d{2})(?:[.,]\d+)?)?\s*([ap]\.?m\.?)?`;

/** A time of day as [h, m, s], from "8:00", "08.30", "8:00:00 PM"; else null. */
export function parseTime(cell) {
  if (cell instanceof Date) return [cell.getHours(), cell.getMinutes(), cell.getSeconds()];
  const m = new RegExp(`^(?:klo\\s*)?${TIME}$`, "i").exec(String(cell ?? "").trim());
  return m ? timeOf(m.slice(1)) : null;
}
function timeOf([h, mi, s, ap]) {
  let hh = +h;
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (/^p/i.test(ap) ? 12 : 0);
  }
  if (hh > 23 || +mi > 59 || +(s || 0) > 59) return null;
  return [hh, +mi, +(s || 0)];
}
function local(y, mo, d, t) {
  if (y < 100) y += 2000;
  const [h, mi, s] = t || [12, 0, 0]; // a date alone: midday, clear of any day boundary
  const dt = new Date(y, mo - 1, d, h, mi, s);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return toLocalStr(dt);
}
const DMY = new RegExp(
  String.raw`^(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})\.?(?:(?:\s+|,\s*|T)(?:klo\s*)?${TIME})?$`,
  "i",
);
const YMD = new RegExp(
  String.raw`^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:(?:\s+|T)${TIME})?\s*(Z|[+-]\d{2}:?\d{2})?$`,
  "i",
);
const NAMED = new RegExp(
  String.raw`^(?:[a-z]+,?\s+)?(?:(\d{1,2})\.?\s+([a-z]{3,})\.?|([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?)\s+(\d{4})(?:(?:\s+|,\s*)${TIME})?$`,
  "i",
);

/** The day and month of a date written as d.m.y or m/d/y, for telling which order a file uses; else null. */
export function dayMonthParts(cell) {
  const m = typeof cell === "string" && DMY.exec(cell.trim());
  return m ? [+m[1], +m[3], m[2]] : null;
}

/**
 * A cell as a local date and time "2026-11-02T08:00:00", or null. `order` says how to read 3.4.2026 or 3/4/2026:
 * "dmy" (3 April) or "mdy" (March 4). A date without a time gets midday.
 */
export function parseWhen(cell, order = "dmy") {
  if (cell instanceof Date) return Number.isNaN(+cell) ? null : toLocalStr(cell);
  const s = String(cell ?? "").trim();
  let m = YMD.exec(s);
  if (m) {
    const t = m[5] ? timeOf(m.slice(5, 9)) : null;
    if (m[5] && !t) return null;
    if (m[9]) {
      // with a time zone: that moment, in this device's local time
      const z = m[9].toUpperCase() === "Z" ? "Z" : m[9].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
      const d = new Date(
        `${m[1]}-${pad(m[3])}-${pad(m[4])}T${pad(t?.[0] ?? 0)}:${pad(t?.[1] ?? 0)}:${pad(t?.[2] ?? 0)}${z}`,
      );
      return Number.isNaN(+d) ? null : toLocalStr(d);
    }
    return local(+m[1], +m[3], +m[4], t);
  }
  m = DMY.exec(s);
  if (m) {
    const t = m[5] ? timeOf(m.slice(5, 9)) : null;
    if (m[5] && !t) return null;
    const [d, mo] = order === "mdy" ? [+m[3], +m[1]] : [+m[1], +m[3]];
    return local(+m[4], mo, d, t);
  }
  m = NAMED.exec(s);
  if (m) {
    const name = (m[2] || m[3]).slice(0, 3).toLowerCase(),
      mo = MONTHS.indexOf(name) + 1;
    if (!mo) return null;
    const t = m[6] ? timeOf(m.slice(6, 10)) : null;
    if (m[6] && !t) return null;
    return local(+m[5], mo, +(m[1] || m[4]), t);
  }
  return null;
}

/**
 * Which order a column's d.m.y / m/d/y dates are in: "dmy" or "mdy", and whether the dates themselves settle it (a
 * day over 12 somewhere). Unsettled, dots mean d.m.y and slashes follow `locale` (US: m/d/y).
 */
export function dateOrder(cells, locale = "en-GB") {
  let dmy = false,
    mdy = false,
    seen = false,
    sep = "";
  for (const c of cells) {
    const p = dayMonthParts(c);
    if (!p) continue;
    seen = true;
    sep ||= p[2];
    if (p[0] > 12) dmy = true;
    if (p[1] > 12) mdy = true;
  }
  if (!seen) return { order: "dmy", settled: true };
  if (dmy !== mdy) return { order: dmy ? "dmy" : "mdy", settled: true };
  const usFirst = sep === "/" && /^en-(US|PH)|^es-US/i.test(locale);
  return { order: usFirst ? "mdy" : "dmy", settled: false };
}

// ---- Tables into metrics ----

const isDateLike = (c) => c instanceof Date || parseWhen(c, "dmy") != null || parseWhen(c, "mdy") != null;
const share = (cells, test) => {
  const filled = cells.filter((c) => c !== "" && c != null);
  return filled.length ? filled.filter(test).length / filled.length : 0;
};

/**
 * What a table holds: `{groups: [{name, entries: [{s, v, n?}], bad}], order, settled, example?, skipped, unused, error?}`.
 * `example`: when the dates leave day and month open, one of them as [first number, second number, as written].
 * `skipped`: rows with values but no readable date. `unused`: columns left out (text that isn't a note).
 * `opts`: {name: the file's name for a sheet without headers, order: "dmy"/"mdy" to override, locale}.
 */
export function readTable(rows, opts = {}) {
  const out = { groups: [], order: "dmy", settled: true, skipped: 0, unused: [] };
  rows = rows.filter((r) => r.some((c) => c !== "" && c != null));
  if (!rows.length) return { ...out, error: "empty" };
  const width = Math.max(...rows.map((r) => r.length));
  const col = (i, from) => rows.slice(from).map((r) => r[i] ?? "");
  // A header row: its first row has no date in it while the rows below do
  const head = rows.length > 1 && !rows[0].some(isDateLike) && rows.slice(1, 6).some((r) => r.some(isDateLike));
  const from = head ? 1 : 0;
  const names = head ? rows[0].map((c) => String(c ?? "").trim()) : [];
  const low = names.map((n) => n.toLowerCase());
  // The date column: the one most cells of which read as dates
  let dateCol = -1,
    best = 0;
  for (let i = 0; i < width; i++) {
    const f = share(col(i, from), isDateLike);
    if (f > best + 1e-9) [dateCol, best] = [i, f];
  }
  if (dateCol < 0 || best < 0.5) return { ...out, error: "nodates" };
  // A separate time column: named so, or right after the date with times only
  let timeCol = low.findIndex((n, i) => i !== dateCol && TIME_HEADERS.test(n));
  if (timeCol < 0 && dateCol + 1 < width && share(col(dateCol + 1, from), (c) => parseTime(c) && !isDateLike(c)) > 0.8)
    timeCol = dateCol + 1;
  const { order: guessed, settled } = dateOrder(col(dateCol, from), opts.locale);
  const order = opts.order || guessed;
  Object.assign(out, { order, settled: opts.order ? true : settled });
  if (!settled) {
    // a date from the file that reads differently either way, to ask about
    const ex = col(dateCol, from).find((c) => {
      const p = dayMonthParts(c);
      return p && p[0] !== p[1];
    });
    if (ex) out.example = dayMonthParts(ex).slice(0, 2).concat(String(ex).trim().split(/\s/)[0]);
  }
  const when = (r) => {
    let s = parseWhen(r[dateCol], order);
    if (s && timeCol >= 0) {
      const t = parseTime(r[timeCol]);
      if (t) s = `${s.slice(0, 11)}${pad(t[0])}:${pad(t[1])}:${pad(t[2])}`;
    }
    return s;
  };
  const metricCol = low.findIndex((n) => n === "metric" || n === "mittari");
  const used = new Set([dateCol, timeCol, metricCol].filter((i) => i >= 0));
  const numberCols = [],
    textCols = [];
  for (let i = 0; i < width; i++) {
    if (used.has(i)) continue;
    const cells = col(i, from);
    if (!cells.some((c) => c !== "" && c != null)) continue;
    (share(cells, (c) => parseNumber(c) != null) >= 0.6 ? numberCols : textCols).push(i);
  }
  const noteCol = textCols.find((i) => NOTE_HEADERS.test(low[i] || "")) ?? -1;
  // Notes go with the values when it's clear which: one number column, or a long sheet
  const notes = noteCol >= 0 && (numberCols.length === 1 || metricCol >= 0);
  out.unused = textCols.filter((i) => !(notes && i === noteCol)).map((i) => names[i] || `Column ${i + 1}`);
  const base = normName(String(opts.name || "").replace(/\.[a-z0-9]+$/i, "")) || "Imported";
  const groups = new Map();
  const group = (key, name) => {
    if (!groups.has(key)) groups.set(key, { name, entries: [], bad: 0 });
    return groups.get(key);
  };
  for (const r of rows.slice(from)) {
    const s = when(r);
    const values = numberCols.filter((i) => (r[i] ?? "") !== "");
    if (!s) {
      if (values.length) out.skipped++;
      continue;
    }
    const n = notes ? String(r[noteCol] ?? "").trim() : "";
    for (const i of values) {
      let g;
      if (metricCol >= 0) {
        const name = normName(String(r[metricCol] ?? ""));
        if (!name) {
          out.skipped++;
          continue;
        }
        g = group(name.toLowerCase(), name);
      } else {
        const header = normName(names[i] || "");
        const name = header || (numberCols.length > 1 ? `${base} ${numberCols.indexOf(i) + 1}` : base);
        g = group(`#${i}`, name);
      }
      const v = parseNumber(r[i]);
      if (v == null) g.bad++;
      else g.entries.push({ s, v, ...(n ? { n } : {}) });
    }
  }
  out.groups = [...groups.values()].filter((g) => g.entries.length || g.bad);
  if (!out.groups.length) return { ...out, error: "novalues" };
  return out;
}
