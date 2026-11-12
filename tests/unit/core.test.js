import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { csvq, decodeLoggrName, parseCSVLine, parseDate, readCSV } from "../../src/core/csv.js";
import { evalExpr } from "../../src/core/expr.js";
import { ago, clock, dayLabel, fmt, periodLabel, timeLabel, toLocalStr } from "../../src/core/format.js";
import { uuid4, uuid5 } from "../../src/core/ids.js";
import { normName, safeFile, sameName } from "../../src/core/names.js";
import { startOf } from "../../src/core/periods.js";
import { prefs } from "../../src/core/prefs.js";
import { pearson, stats } from "../../src/core/stats.js";

const local = (s) => +new Date(s);

describe("evalExpr", () => {
  it("reads numbers with a decimal comma or point", () => {
    assert.equal(evalExpr("5,5"), 5.5);
    assert.equal(evalExpr("5.5"), 5.5);
    assert.equal(evalExpr(" 12 "), 12);
  });
  it("does arithmetic with the keypad's operators and brackets", () => {
    assert.equal(evalExpr("2+3"), 5);
    assert.equal(evalExpr("10−2×3"), 4);
    assert.equal(evalExpr("(10-2)×1,5"), 12);
    assert.equal(evalExpr("9÷3"), 3);
    assert.equal(evalExpr("-4+1"), -3);
    assert.equal(evalExpr("0,1+0,2"), 0.3);
  });
  it("rejects anything else", () => {
    for (const s of ["", "abc", "2+", "(1", "1/0", "1..2", "5 kg"]) assert.equal(evalExpr(s), null, s);
  });
});

describe("periods", () => {
  it("starts weeks on Monday or Sunday", () => {
    const thu = local("2026-11-05T15:00:00");
    assert.equal(startOf(thu, "weekly", 1), local("2026-11-02T00:00:00"));
    assert.equal(startOf(thu, "weekly", 0), local("2026-11-01T00:00:00"));
    assert.equal(startOf(local("2026-11-01T10:00:00"), "weekly", 1), local("2026-10-26T00:00:00"));
  });
  it("starts days and months at midnight", () => {
    assert.equal(startOf(local("2026-11-05T15:00:00"), "daily"), local("2026-11-05T00:00:00"));
    assert.equal(startOf(local("2026-11-05T15:00:00"), "monthly"), local("2026-11-01T00:00:00"));
  });
  it("labels periods", () => {
    assert.equal(periodLabel(local("2026-11-01T00:00:00"), "monthly"), "Nov 2026");
    assert.equal(periodLabel(local("2026-11-02T00:00:00"), "weekly"), "Nov 2 - Nov 8 2026");
    assert.equal(periodLabel(local("2026-12-28T00:00:00"), "weekly"), "Dec 28 2026 - Jan 3 2027");
    assert.equal(periodLabel(local("2026-11-05T00:00:00"), "daily"), "Nov 5 2026");
    assert.equal(dayLabel(local("2026-11-05T08:00:00")), "Nov 5 2026");
  });
});

describe("format", () => {
  it("formats numbers the Finnish way", () => {
    assert.equal(fmt(1234.5).replace(/\s/g, " "), "1 234,5");
    assert.equal(fmt(Number.NaN), "–");
  });
  it("shows the time in 24-hour or AM/PM format", () => {
    const t = local("2026-11-05T15:04:00");
    const was = prefs.h24;
    try {
      prefs.h24 = true;
      assert.equal(clock(t), "15:04");
      assert.equal(timeLabel(t), "Nov 5 2026 - 15:04");
      prefs.h24 = false;
      assert.equal(clock(t), "3:04 PM");
      assert.equal(clock(local("2026-11-05T00:30:00")), "12:30 AM");
    } finally {
      prefs.h24 = was;
    }
  });
  it("says how long ago", () => {
    const now = local("2026-11-07T12:00:00");
    assert.equal(ago(now - 30e3, now), "Just now");
    assert.equal(ago(now - 2 * 3600e3, now), "2 hours ago");
    assert.equal(ago(now - 86400e3, now), "1 day ago");
  });
  it("writes naive local times", () => {
    assert.equal(toLocalStr(new Date(2026, 0, 15, 7, 30, 5)), "2026-01-15T07:30:05");
  });
});

describe("stats", () => {
  it("computes min, max, mean, median, total and deviation", () => {
    assert.deepEqual(stats([1, 2, 3, 4]), { min: 1, max: 4, mean: 2.5, med: 2.5, tot: 10, sd: Math.sqrt(1.25) });
    assert.equal(stats([5, 1, 3]).med, 3);
    assert.equal(stats([]), null);
  });
  it("correlates series of at least five pairs", () => {
    assert.equal(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1);
    assert.ok(Math.abs(pearson([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]) + 1) < 1e-12);
    assert.equal(pearson([1, 2, 3, 4], [1, 2, 3, 4]), null);
    assert.equal(pearson([1, 1, 1, 1, 1], [1, 2, 3, 4, 5]), null);
  });
});

describe("ids", () => {
  it("derives the same UUIDv5 as Python's uuid.uuid5", async () => {
    // python3 -c "import uuid;ns=uuid.uuid5(uuid.NAMESPACE_URL,'https://lokki.jocke.fi/entries');print(uuid.uuid5(ns,'running|2026-01-15T07:30:00|2.5|0'))"
    assert.equal(await uuid5("running|2026-01-15T07:30:00|2.5|0"), "b40e5589-5bc6-581c-8137-d78c1803269f");
  });
  it("makes random UUIDv4s", () => {
    assert.match(uuid4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("names", () => {
  it("treats look-alike names as the same", () => {
    assert.equal(normName("  Walk/Run​  "), "Walk/Run");
    assert.equal(normName("Café"), "Café");
    assert.ok(sameName("café", "CAFÉ"));
    assert.ok(!sameName("Run", "Running"));
  });
  it("makes file names safe", () => {
    assert.equal(safeFile("Walk/Run"), "Walk-Run");
    assert.equal(safeFile('a:b*c?"d<e>f|g\\h'), "a-b-c--d-e-f-g-h");
    assert.equal(safeFile(" .. "), "metric");
  });
});

describe("csv", () => {
  it("quotes only when needed", () => {
    assert.equal(csvq("plain"), "plain");
    assert.equal(csvq('say "hi", ok'), '"say ""hi"", ok"');
    assert.equal(csvq(null), "");
  });
  it("splits lines with quoted fields", () => {
    assert.deepEqual(parseCSVLine('a,"b,c","d ""e"""'), ["a", "b,c", 'd "e"']);
  });
  it("reads Lokki and old Loggr dates", () => {
    assert.equal(parseDate("2026-01-15 07:30:00"), "2026-01-15T07:30:00");
    assert.equal(parseDate("2026-1-15 7:30"), "2026-01-15T07:30:00");
    assert.equal(parseDate("2026-11-2 8:00:00 PM"), "2026-11-02T20:00:00");
    assert.equal(parseDate("2026-11-2 12:15:00 AM"), "2026-11-02T00:15:00");
    assert.equal(parseDate("7.11.2026"), null);
  });
  it("reads files with and without a header", () => {
    const all = readCSV('Metric,Date,Value,Note\nRunning,2026-01-15 07:30:00,2.5,"long, slow"\nBad,,x,\n', "ignored");
    assert.deepEqual(all, { rows: [{ name: "Running", s: "2026-01-15T07:30:00", v: 2.5, n: "long, slow" }], bad: 1 });
    const old = readCSV("2026-11-2 8:00:00 AM, 3\n2026-11-3 8:00:00 AM, 2,5\n", "Café");
    assert.deepEqual(
      old.rows.map((r) => [r.name, r.s, r.v]),
      [
        ["Café", "2026-11-02T08:00:00", 3],
        ["Café", "2026-11-03T08:00:00", 2],
      ],
    );
    assert.equal(readCSV("Metric,Date,Value\nA,2026-01-01 10:00,1\nB,2026-01-01 10:00,2\n", "", "b").rows.length, 1);
  });
  it("decodes old Loggr file names", () => {
    assert.equal(decodeLoggrName("Caf#U00e9.csv"), "Café");
  });
});
