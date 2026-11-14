// Restoring a backup, and deleting a metric, on this device's copy.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { planRestore } from "../../src/data/backup.js";
import { deleteMetricOps } from "../../src/data/records.js";
import { metricAll, recs } from "../../src/data/state.js";

const reset = () => {
  metricAll.clear();
  recs.clear();
};
const live = (id, m, t, v, u, n) => ({ id, m, y: +t.slice(0, 4), t, v, u, ...(n ? { n } : {}) });

describe("deleting a metric", () => {
  beforeEach(reset);
  it("starts a new generation and blanks its entries, so their contents leave the servers", () => {
    metricAll.set("run", { name: "Running", u: 1 });
    recs.set("a", live("a", "run", "2026-01-01T10:00:00", 5, 10, "note"));
    recs.set("b", { id: "b", m: "run", y: 2026, u: 11, d: true });
    recs.set("c", live("c", "walk", "2026-01-01T10:00:00", 2, 10));

    const ops = deleteMetricOps("run", 100);

    assert.deepEqual(metricAll.get("run"), { deleted: true, u: 100, g: 100, sb: 0 });
    const a = recs.get("a");
    assert.deepEqual([a.d, a.t, a.v, a.n, a.sb, a.u > 10], [true, undefined, undefined, undefined, 0, true]);
    assert.equal(recs.get("b").u, 11, "already deleted: left alone");
    assert.equal(recs.get("c").d, undefined, "another metric's entry: left alone");
    assert.deepEqual(
      ops.map(([store, op, v]) => [store, op, v.id]),
      [
        ["metrics", "put", "run"],
        ["recs", "put", "a"],
      ],
    );
  });
});

describe("planning a restore", () => {
  beforeEach(reset);
  const backup = (metrics, entries) => ({
    metrics: new Map(metrics.map((m) => [m.id, m])),
    entries: new Map(entries.map((e) => [e.id, e])),
  });
  it("adds what's missing and never overwrites anything newer", () => {
    metricAll.set("run", { name: "Running", u: 10 });
    recs.set("a", live("a", "run", "2026-01-01T10:00:00", 1, 100));
    const p = planRestore(
      backup(
        [{ id: "run", name: "Running", u: 5 }],
        [
          { id: "a", metric: "run", t: "2026-01-01T10:00:00", v: 7, u: 50, d: false },
          { id: "b", metric: "run", t: "2026-01-02T10:00:00", v: 2, u: 50, d: false },
        ],
      ),
    );
    assert.deepEqual(
      p.addE.map((e) => e.id),
      ["b"],
    );
    assert.equal(p.updE.length + p.updM.length, 0);
  });
  it("offers to bring back what was deleted since", () => {
    metricAll.set("walk", { deleted: true, u: 10 });
    metricAll.set("run", { name: "Running", u: 1 });
    recs.set("r", { id: "r", m: "run", y: 2026, u: 100, d: true });
    const p = planRestore(
      backup(
        [
          { id: "walk", name: "Walking", u: 5 },
          { id: "run", name: "Running", u: 1 },
        ],
        [
          { id: "s", metric: "walk", t: "2026-01-01T10:00:00", v: 1, u: 5, d: false },
          { id: "r", metric: "run", t: "2026-01-01T10:00:00", v: 1, u: 50, d: false },
        ],
      ),
    );
    assert.deepEqual(
      p.bringM.map((m) => m.id),
      ["walk"],
    );
    assert.deepEqual(
      p.bringE.map((x) => x.be.id),
      ["s", "r"],
    );
    assert.equal(p.addE.length, 0);
  });
});
