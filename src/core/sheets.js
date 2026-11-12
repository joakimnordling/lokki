/* Spreadsheets: the cells of a modern Excel (.xlsx) or OpenDocument (.ods) file, sheet by sheet, for readTable
   (table.js). Both are zip files of XML, so this needs only the browser's own unzip (DecompressionStream) and XML
   parser (DOMParser). It reads values, not looks: what a cell holds, with dates as dates.

   A cell comes out as a number, a string, or for dates and times a string table.js reads: "2026-11-02" for a date
   alone (Lokki puts it at midday, as for a CSV), "2026-11-02T08:30:00" with a time, "08:30:00" for a time alone. */
import { unzipEntry, zipEntries } from "./zip.js";

const pad = (n) => String(n).padStart(2, "0");
const xml = (bytes) => new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
const all = (node, name) => [...node.getElementsByTagNameNS("*", name)];
const kids = (node, name) => [...node.childNodes].filter((n) => n.nodeType === 1 && n.localName === name);
const attr = (el, name) => {
  for (const a of el.attributes) if (a.localName === name) return a.value;
  return null;
};

/** What kind of file `bytes` is: "xlsx", "ods", "xls" (the old binary Excel), "numbers", "zip" or null. */
export function sheetKind(bytes) {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return "xls";
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null;
  let names;
  try {
    names = zipEntries(bytes).map((e) => e.name);
  } catch {
    return null;
  }
  if (names.includes("xl/workbook.xml")) return "xlsx";
  if (names.includes("content.xml") && names.includes("mimetype")) return "ods";
  if (names.some((n) => n.startsWith("Index/") || n.endsWith(".iwa"))) return "numbers";
  return "zip";
}

/** A spreadsheet's sheets as [{name, rows}], rows being arrays of cells. Throws on a file it can't read. */
export async function readSheets(bytes) {
  const kind = sheetKind(bytes);
  if (kind === "xlsx") return readXlsx(bytes);
  if (kind === "ods") return readOds(bytes);
  throw new Error(kind || "unknown");
}

async function files(bytes, wanted) {
  const out = {};
  for (const e of zipEntries(bytes)) if (wanted(e.name)) out[e.name] = await unzipEntry(bytes, e);
  return out;
}

// ---- Excel ----

// Built-in number formats that are dates or times (ECMA-376, 18.8.30), and those that are times only
const DATE_IDS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);
const TIME_IDS = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56]);

/** What a number format shows: "date", "datetime", "time", "duration" or null (a plain number). */
export function formatKind(code) {
  const s = String(code)
    .split(";")[0]
    .replace(/"[^"]*"|\\.|_.|\*./g, "") // quoted text, escaped and padding characters
    .replace(/\[(?!(h+|m+|s+)\])[^\]]*\]/gi, "") // colours and locales, keeping [h] [m] [s]
    .replace(/AM\/PM|A\/P/gi, "")
    .toLowerCase();
  if (/\[(h+|m+|s+)\]/.test(s)) return "duration";
  // Runs of the same letter; an m right after an h, or right before an s, is minutes, any other m is the month
  const runs = s.match(/([dymhs])\1*/g) || [];
  let date = false,
    time = false;
  runs.forEach((r, i) => {
    if (r[0] === "d" || r[0] === "y") date = true;
    else if (r[0] === "h" || r[0] === "s") time = true;
    else if (r.length <= 2 && (runs[i - 1]?.[0] === "h" || runs[i + 1]?.[0] === "s")) time = true;
    else date = true;
  });
  if (date && time) return "datetime";
  if (date) return "date";
  if (time) return "time";
  return null;
}

// A date serial (days since the workbook's start) as the string described at the top
function serialToCell(n, kind, date1904) {
  if (kind === "duration" || kind === "time") {
    if (kind === "time" || n < 1) {
      const sec = Math.round((n - Math.floor(n)) * 86400);
      return `${pad(Math.floor(sec / 3600) % 24)}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
    }
    return n; // a duration over a day: keep the number of days
  }
  // Day 1 is 1 Jan 1900; Excel counts a 29 Feb 1900 that never was, so from day 61 on, day 0 is 30 Dec 1899
  const days = date1904 ? n + 1462 : n < 61 ? n + 1 : n;
  const ms = Math.round(days * 86400) * 1000 + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (kind === "date" && Number.isInteger(n)) return ymd;
  return `${ymd}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// "C12" → 2 (columns from 0)
function colOf(ref) {
  const m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return -1;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
  return c - 1;
}

async function readXlsx(bytes) {
  const f = await files(bytes, (n) =>
    /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/.+\.xml)$/.test(n),
  );
  const wb = xml(f["xl/workbook.xml"]);
  const date1904 = all(wb, "workbookPr").some((p) => /^(1|true)$/.test(attr(p, "date1904") || ""));
  const rels = {};
  if (f["xl/_rels/workbook.xml.rels"])
    for (const r of all(xml(f["xl/_rels/workbook.xml.rels"]), "Relationship"))
      rels[attr(r, "Id")] = attr(r, "Target").replace(/^\/?(xl\/)?/, "xl/");
  // Shared strings: each <si> is its text runs, without phonetic guides
  const shared = f["xl/sharedStrings.xml"]
    ? all(xml(f["xl/sharedStrings.xml"]), "si").map((si) =>
        all(si, "t")
          .filter((t) => t.parentNode.localName !== "rPh")
          .map((t) => t.textContent)
          .join(""),
      )
    : [];
  // Each cell style's kind of number format
  const kinds = [];
  if (f["xl/styles.xml"]) {
    const st = xml(f["xl/styles.xml"]);
    const custom = {};
    for (const nf of all(st, "numFmt")) custom[attr(nf, "numFmtId")] = attr(nf, "formatCode");
    const xfs = all(st, "cellXfs")[0];
    for (const xf of xfs ? kids(xfs, "xf") : []) {
      const id = +(attr(xf, "numFmtId") || 0);
      kinds.push(
        custom[id] != null
          ? formatKind(custom[id])
          : DATE_IDS.has(id)
            ? id === 22
              ? "datetime"
              : "date"
            : TIME_IDS.has(id)
              ? id === 46
                ? "duration"
                : "time"
              : null,
      );
    }
  }
  const sheets = [];
  for (const s of all(wb, "sheet")) {
    const target = rels[attr(s, "id")] || `xl/worksheets/sheet${sheets.length + 1}.xml`;
    if (!f[target]) continue;
    const rows = [];
    for (const row of all(xml(f[target]), "row")) {
      const r = +(attr(row, "r") || rows.length + 1) - 1;
      const cells = [];
      for (const c of kids(row, "c")) {
        let i = colOf(attr(c, "r"));
        if (i < 0) i = cells.length;
        const t = attr(c, "t"),
          v = kids(c, "v")[0]?.textContent ?? "";
        let val = "";
        if (t === "s") val = shared[+v] ?? "";
        else if (t === "inlineStr")
          val = all(c, "t")
            .map((x) => x.textContent)
            .join("");
        else if (t === "str") val = v;
        else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
        else if (t === "d") val = v.replace(/Z$/, "");
        else if (t === "e") val = "";
        else if (v !== "") {
          const n = Number(v),
            kind = kinds[+(attr(c, "s") || 0)];
          val = kind && Number.isFinite(n) ? serialToCell(n, kind, date1904) : n;
        }
        while (cells.length < i) cells.push("");
        cells[i] = val;
      }
      if (r > rows.length + 10000) break; // far below the data: something odd, stop rather than fill
      while (rows.length < r) rows.push([]);
      rows[r] = cells;
    }
    sheets.push({ name: attr(s, "name") || `Sheet ${sheets.length + 1}`, rows });
  }
  return sheets;
}

// ---- OpenDocument ----

const MAX_REPEAT = 1000; // empty rows and cells repeated to the sheet's end are left out

function odsText(cell) {
  return kids(cell, "p")
    .map((p) => {
      let s = "";
      const walk = (n) => {
        for (const k of n.childNodes) {
          if (k.nodeType === 3) s += k.nodeValue;
          else if (k.nodeType === 1)
            if (k.localName === "s") s += " ".repeat(+(attr(k, "c") || 1));
            else if (k.localName === "tab") s += "\t";
            else if (k.localName === "line-break") s += "\n";
            else if (k.localName !== "annotation") walk(k);
        }
      };
      walk(p);
      return s;
    })
    .join("\n");
}
function odsValue(cell) {
  const type = attr(cell, "value-type");
  if (!type) return "";
  if (type === "float" || type === "percentage" || type === "currency") return Number(attr(cell, "value"));
  if (type === "date") {
    const v = attr(cell, "date-value") || "";
    return /T00:00(:00)?$/.test(v) ? v.slice(0, 10) : v.replace(/(\.\d+)?Z?$/, "");
  }
  if (type === "time") {
    const m = /^-?PT(\d+)H(\d+)M(\d+)(?:[.,]\d+)?S$/.exec(attr(cell, "time-value") || "");
    return m ? `${pad(+m[1] % 24)}:${pad(+m[2])}:${pad(+m[3])}` : odsText(cell);
  }
  if (type === "boolean") return attr(cell, "boolean-value") === "true" ? "TRUE" : "FALSE";
  return odsText(cell);
}

async function readOds(bytes) {
  const f = await files(bytes, (n) => n === "content.xml");
  const doc = xml(f["content.xml"]);
  return all(doc, "table")
    .filter((t) => t.namespaceURI?.includes(":table:"))
    .map((table, k) => {
      const rows = [];
      const addRow = (row) => {
        const cells = [];
        for (const c of [...row.childNodes].filter((n) => n.nodeType === 1 && /table-cell$/.test(n.localName))) {
          const v = c.localName === "covered-table-cell" ? "" : odsValue(c);
          const n = Math.min(+(attr(c, "number-columns-repeated") || 1), v === "" ? MAX_REPEAT : 100000);
          for (let i = 0; i < n; i++) cells.push(v);
        }
        while (cells.length && cells.at(-1) === "") cells.pop();
        const n = +(attr(row, "number-rows-repeated") || 1);
        for (let i = 0; i < (cells.length ? Math.min(n, 100000) : Math.min(n, MAX_REPEAT)); i++) rows.push(cells);
      };
      const walk = (node) => {
        for (const n of node.childNodes)
          if (n.nodeType === 1)
            if (n.localName === "table-row") addRow(n);
            else if (/^table-(rows|header-rows|row-group)$/.test(n.localName)) walk(n);
      };
      walk(table);
      while (rows.length && !rows.at(-1).length) rows.pop();
      return { name: attr(table, "name") || `Sheet ${k + 1}`, rows };
    });
}
