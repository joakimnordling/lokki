// Reading logs out of tables: CSV files as people have them (src/core/table.js).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  csvRows,
  dateOrder,
  guessDelimiter,
  parseNumber,
  parseTime,
  parseWhen,
  readTable,
} from "../../src/core/table.js";

const read = (text, opts = {}) => readTable(csvRows(text), { name: "Steps.csv", ...opts });
const pairs = (g) => g.entries.map((e) => [e.s, e.v]);

describe("numbers", () => {
  it("reads decimal commas and points, thousands separators and units", () => {
    const cases = [
      ["79.4", 79.4],
      ["79,4", 79.4],
      ["-2,5", -2.5],
      ["1 234,5", 1234.5],
      ["1 234", 1234],
      ["1.234,5", 1234.5],
      ["1,234.5", 1234.5],
      ["1,234,567", 1234567],
      ["1.234.567", 1234567],
      ["5 km", 5],
      ["79,4 kg", 79.4],
      ["12%", 12],
      [42, 42],
    ];
    for (const [cell, v] of cases) assert.equal(parseNumber(cell), v, String(cell));
    for (const cell of ["", "abc", "1-2", "12 eggs and ham", "2026-11-02", null]) assert.equal(parseNumber(cell), null);
  });
});

describe("dates and times", () => {
  it("reads the common ways to write a date, with or without a time", () => {
    const cases = [
      ["2026-11-02 08:00:00", "2026-11-02T08:00:00"],
      ["2026-11-2 8:00:00 PM", "2026-11-02T20:00:00"],
      ["2026-11-02T08:30", "2026-11-02T08:30:00"],
      ["2026/11/02", "2026-11-02T12:00:00"],
      ["2.11.2026", "2026-11-02T12:00:00"],
      ["2.11.2026 8.30", "2026-11-02T08:30:00"],
      ["2.11.2026 klo 8.30", "2026-11-02T08:30:00"],
      ["02.11.26", "2026-11-02T12:00:00"],
      ["2/11/2026 08:00", "2026-11-02T08:00:00"],
      ["Nov 2, 2026", "2026-11-02T12:00:00"],
      ["November 2, 2026 8:00 AM", "2026-11-02T08:00:00"],
      ["2 Nov 2026", "2026-11-02T12:00:00"],
      ["Mon, 2 Nov 2026 18:45", "2026-11-02T18:45:00"],
    ];
    for (const [cell, s] of cases) assert.equal(parseWhen(cell), s, cell);
    assert.equal(parseWhen("11/2/2026", "mdy"), "2026-11-02T12:00:00");
    for (const cell of ["31.2.2026", "2026-13-01", "2.11.2026 25:00", "13:00 PM", "Nov 2026", "", "79,4", "2026"])
      assert.equal(parseWhen(cell), null, cell);
  });

  it("turns a time zone into this device's local time", () => {
    const utc = new Date(Date.UTC(2026, 10, 2, 8, 0));
    const want = parseWhen(utc);
    assert.equal(parseWhen("2026-11-02T08:00:00Z"), want);
    assert.equal(parseWhen("2026-11-02T10:00:00+02:00"), want);
  });

  it("reads times on their own", () => {
    assert.deepEqual(parseTime("8:05"), [8, 5, 0]);
    assert.deepEqual(parseTime("20.30"), [20, 30, 0]);
    assert.deepEqual(parseTime("12:15:30 AM"), [0, 15, 30]);
    assert.equal(parseTime("8"), null);
  });

  it("works out the order of day and month, and says when the dates leave it open", () => {
    assert.deepEqual(dateOrder(["3.4.2026", "13.4.2026"]), { order: "dmy", settled: true });
    assert.deepEqual(dateOrder(["4/3/2026", "4/13/2026"]), { order: "mdy", settled: true });
    assert.deepEqual(dateOrder(["3.4.2026", "5.6.2026"]), { order: "dmy", settled: false });
    assert.deepEqual(dateOrder(["3/4/2026"], "en-US"), { order: "mdy", settled: false });
    assert.deepEqual(dateOrder(["3/4/2026"], "fi-FI"), { order: "dmy", settled: false });
    assert.deepEqual(dateOrder(["2026-04-03"]), { order: "dmy", settled: true });
  });
});

describe("splitting CSV text", () => {
  it("finds the separator", () => {
    assert.equal(guessDelimiter("Date,Value\n2026-11-02,3\n"), ",");
    assert.equal(guessDelimiter("Päivä;Paino\n2.11.2026;79,4\n3.11.2026;79,1\n"), ";");
    assert.equal(guessDelimiter("Date\tValue\n2026-11-02\t3,5\n"), "\t");
  });
  it("keeps quoted separators, quotes and line breaks in a cell", () => {
    assert.deepEqual(csvRows('﻿a,"b,c","say ""hi""\nthere"\n'), [["a", "b,c", 'say "hi"\nthere']]);
  });
});

describe("reading a table", () => {
  it("reads a Finnish Excel CSV: semicolons, d.m.y dates and decimal commas", () => {
    const r = read("Päivämäärä;Paino\n2.11.2026;79,4\n3.11.2026;79,1\n");
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0].name, "Paino");
    assert.deepEqual(pairs(r.groups[0]), [
      ["2026-11-02T12:00:00", 79.4],
      ["2026-11-03T12:00:00", 79.1],
    ]);
    assert.equal(r.settled, false, "2.11 and 3.11 could be either way");
    assert.equal(r.order, "dmy");
  });

  it("reads a wide sheet as one metric per number column, and a separate time column", () => {
    const r = read("Date,Time,Weight,Steps,Sleep\n11/2/2026,7:30,79.4,8500,7.5\n11/3/2026,7:45,79.2,,7\n");
    assert.deepEqual(
      r.groups.map((g) => g.name),
      ["Weight", "Steps", "Sleep"],
    );
    assert.equal(r.order, "dmy", "11/2 and 11/3 leave it open; outside the US, d/m/y");
    assert.equal(r.settled, false);
    const us = read("Date,Time,Weight,Steps,Sleep\n11/2/2026,7:30,79.4,8500,7.5\n11/3/2026,7:45,79.2,,7\n", {
      locale: "en-US",
    });
    assert.deepEqual(pairs(us.groups[0]), [
      ["2026-11-02T07:30:00", 79.4],
      ["2026-11-03T07:45:00", 79.2],
    ]);
    assert.equal(us.groups[1].entries.length, 1, "an empty cell is no entry");
    const chosen = read("Date,Weight\n11/2/2026,79.4\n", { order: "dmy" });
    assert.equal(chosen.groups[0].entries[0].s, "2026-02-11T12:00:00");
    assert.equal(chosen.settled, true);
  });

  it("reads Lokki's own export, one metric per name in its Metric column, with notes", () => {
    const r = read(
      'Metric,Date,Value,Note\nRunning,2026-01-15 07:30:00,2.5,"long, slow"\nSleep,2026-01-15 07:00:00,7,\n',
    );
    assert.deepEqual(
      r.groups.map((g) => [g.name, g.entries]),
      [
        ["Running", [{ s: "2026-01-15T07:30:00", v: 2.5, n: "long, slow" }]],
        ["Sleep", [{ s: "2026-01-15T07:00:00", v: 7 }]],
      ],
    );
  });

  it("reads the old Loggr files: no header, named after the file, unquoted decimal commas", () => {
    const r = read("2026-11-2 8:00:00 AM, 3\r\n2026-11-3 8:00:00 AM, 2,5\r\n", { name: "Café.csv" });
    assert.equal(r.groups[0].name, "Café");
    assert.deepEqual(pairs(r.groups[0]), [
      ["2026-11-02T08:00:00", 3],
      ["2026-11-03T08:00:00", 2.5],
    ]);
  });

  it("keeps a note column with one metric, and lists other text columns as not imported", () => {
    const one = read("Date,Steps,Comment\n2026-11-02,8500,windy\n");
    assert.deepEqual(one.groups[0].entries, [{ s: "2026-11-02T12:00:00", v: 8500, n: "windy" }]);
    assert.deepEqual(one.unused, []);
    const two = read("Date,Steps,Floors,Comment,Place\n2026-11-02,8500,3,windy,Home\n");
    assert.deepEqual(two.unused, ["Comment", "Place"]);
    assert.equal(two.groups[0].entries[0].n, undefined);
  });

  it("names columns without a header after the file", () => {
    const r = read("2026-11-02;3;4\n2026-11-03;5;6\n", { name: "push.csv" });
    assert.deepEqual(
      r.groups.map((g) => g.name),
      ["push 1", "push 2"],
    );
  });

  it("counts what it can't read", () => {
    const r = read("Date,Steps\n2026-11-02,8500\nsoon,9000\n2026-11-04,lots\n2026-11-05,\n");
    assert.equal(r.skipped, 1, "a value without a date");
    assert.equal(r.groups[0].bad, 1, "a date with something not a number");
    assert.equal(r.groups[0].entries.length, 1);
  });

  it("says why when there's nothing to import", () => {
    assert.equal(read("").error, "empty");
    assert.equal(read("Name,Age\nAnna,4\n").error, "nodates");
    assert.equal(read("Date,Place\n2026-11-02,Home\n").error, "novalues");
  });
});
