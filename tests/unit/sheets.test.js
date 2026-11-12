// Reading .xlsx and .ods files (src/core/sheets.js), with files written by openpyxl and LibreOffice
// (tests/fixtures/sheets/make.py). Node has no DOMParser, so the tests lend it xmldom's.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { formatKind, readSheets, sheetKind } from "../../src/core/sheets.js";
import { readTable } from "../../src/core/table.js";
import { zipOne } from "../../src/core/zip.js";

const dir = join(import.meta.dirname, "..", "fixtures", "sheets");
const load = async (name) => new Uint8Array(await readFile(join(dir, name)));

// The same three sheets in every file
const LOG = [
  ["Date", "Time", "Weight", "Steps", "Note"],
  ["2026-11-02", "07:30:00", 79.4, 8500, "windy"],
  ["2026-11-03", "07:45:00", 79.1, "", ""],
  ["2026-11-04", "20:05:00", 78.9, 10200, "long walk"],
];
const MOODS = [
  ["When", "Mood"],
  ["2026-11-02T21:15:00", 7],
  ["2026-11-03T22:00:00", 6],
];
const zip = async (name) => new Uint8Array(await (await zipOne(name, new Uint8Array([1]))).arrayBuffer());
const trim = (rows) => rows.map((r) => r.concat(Array(5).fill("")).slice(0, 5));

describe("spreadsheets", () => {
  before(() => {
    globalThis.DOMParser = DOMParser;
  });

  for (const file of ["openpyxl.xlsx", "libreoffice.xlsx", "libreoffice.ods", "mac1904.xlsx"])
    it(`reads ${file}: its sheets, with dates, times and numbers`, async () => {
      const bytes = await load(file);
      assert.equal(sheetKind(bytes), file.endsWith(".ods") ? "ods" : "xlsx");
      const sheets = await readSheets(bytes);
      assert.deepEqual(
        sheets.map((s) => s.name),
        ["Log", "Moods", "Notes"],
      );
      assert.deepEqual(trim(sheets[0].rows), LOG);
      assert.deepEqual(
        sheets[1].rows.map((r) => r.slice(0, 2)),
        MOODS,
      );
      assert.deepEqual(sheets[2].rows, [["Just some text", "about the logs"]]);
    });

  it("gives readTable what it needs: a metric per column, with the time column and notes", async () => {
    const [log, moods, notes] = await readSheets(await load("libreoffice.ods"));
    const r = readTable(log.rows, { name: "Log" });
    assert.deepEqual(
      r.groups.map((g) => [g.name, g.entries.map((e) => [e.s, e.v])]),
      [
        [
          "Weight",
          [
            ["2026-11-02T07:30:00", 79.4],
            ["2026-11-03T07:45:00", 79.1],
            ["2026-11-04T20:05:00", 78.9],
          ],
        ],
        [
          "Steps",
          [
            ["2026-11-02T07:30:00", 8500],
            ["2026-11-04T20:05:00", 10200],
          ],
        ],
      ],
    );
    assert.deepEqual(r.unused, ["Note"], "two metrics: the notes can't go with either");
    assert.deepEqual(
      readTable(moods.rows, { name: "Moods" }).groups[0].entries.map((e) => e.s),
      ["2026-11-02T21:15:00", "2026-11-03T22:00:00"],
    );
    assert.equal(readTable(notes.rows, { name: "Notes" }).error, "nodates");
  });

  it("tells number formats apart", () => {
    const cases = [
      ["General", null],
      ["0.00", null],
      ['#,##0 "kg"', null],
      ["[Red]0.00", null],
      ["d.m.yyyy", "date"],
      ["mm/dd/yy", "date"],
      ["[$-409]mmmm d, yyyy", "date"],
      ["yyyy-mm-dd hh:mm", "datetime"],
      ["m/d/yy h:mm AM/PM", "datetime"],
      ["h:mm", "time"],
      ["h:mm AM/PM", "time"],
      ["mm:ss", "time"],
      ["[h]:mm:ss", "duration"],
      ['d "days"', "date"],
    ];
    for (const [code, kind] of cases) assert.equal(formatKind(code), kind, code);
  });

  it("says what other files are", async () => {
    assert.equal(sheetKind(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])), "xls");
    assert.equal(sheetKind(new TextEncoder().encode("Date,Value\n")), null);
    assert.equal(sheetKind(await zip("Index/Document.iwa")), "numbers");
    assert.equal(sheetKind(await zip("photo.jpg")), "zip");
    await assert.rejects(readSheets(await zip("photo.jpg")), /zip/);
  });
});
