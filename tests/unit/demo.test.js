// The demo's made-up year of logs (src/core/demo.js).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO, DEMO_METRICS, demoData } from "../../src/core/demo.js";

const END = new Date(2026, 10, 8, 20, 30);
const local = (d) => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 19);

describe("demo data", () => {
  it("is off outside a browser's ?demo", () => assert.equal(DEMO, false));

  it("is the same every time for the same moment", () => {
    assert.deepEqual(demoData(END), demoData(new Date(END)));
  });

  it("covers the year up to the moment, and nothing after it", () => {
    for (const end of [END, new Date(2026, 0, 1, 0, 5), new Date(2026, 1, 28, 7, 15)]) {
      const { entries } = demoData(end);
      const ts = entries
        .filter((e) => e.m !== "cycling")
        .map((e) => e.t)
        .sort();
      assert.ok(ts.at(-1) <= local(end), `${ts.at(-1)} after ${local(end)}`);
      assert.ok(ts[0] >= local(new Date(end.getFullYear() - 1, end.getMonth(), end.getDate())));
      assert.ok(ts[0].slice(0, 10) <= local(new Date(end.getFullYear() - 1, end.getMonth(), end.getDate() + 3)));
    }
    // A morning: today's evening entries aren't there yet, its morning ones are
    const today = demoData(new Date(2026, 10, 8, 7, 59)).entries.filter((e) => e.t.startsWith("2026-11-08"));
    assert.ok(today.some((e) => e.m === "sleep"));
    assert.ok(!today.some((e) => e.m === "steps"));
  });

  it("has every metric, with entries that point at them and unique ids", () => {
    const { metrics, entries } = demoData(END);
    assert.deepEqual(
      metrics.map((m) => m.id),
      DEMO_METRICS.map((m) => m.id),
    );
    const ids = new Set(metrics.map((m) => m.id));
    for (const id of ids)
      assert.ok(
        entries.some((e) => e.m === id),
        id,
      );
    assert.ok(entries.every((e) => ids.has(e.m) && typeof e.v === "number" && e.y === +e.t.slice(0, 4)));
    assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
    assert.equal(new Set([...metrics, ...entries].map((r) => r.u)).size, metrics.length + entries.length);
  });

  it("has five years of Cycling, more each year, without changing the other metrics' year", () => {
    const { metrics, entries } = demoData(END);
    const rides = entries.filter((e) => e.m === "cycling");
    assert.equal(rides[0].t.slice(0, 4), "2021");
    assert.equal(metrics.find((m) => m.id === "cycling").created.slice(0, 4), "2021");
    const perYear = (y) => rides.filter((e) => e.y === y).length;
    assert.ok(perYear(2022) < perYear(2024), `${perYear(2022)} rides in 2022, ${perYear(2024)} in 2024`);
    assert.ok(
      rides.every((e, i) => i === 0 || e.t > rides[i - 1].t),
      "in order",
    );
  });

  it("tells a story: weight goes down over the year", () => {
    const w = demoData(END).entries.filter((e) => e.m === "body-weight");
    const avg = (xs) => xs.reduce((a, e) => a + e.v, 0) / xs.length;
    assert.ok(avg(w.slice(0, 30)) - avg(w.slice(-30)) > 4);
  });
});
