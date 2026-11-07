import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { planRestore } from "../../src/data/backup.js";
import { deleteMetricOps } from "../../src/data/records.js";
import { knownDocs, metricAll, outbox, recs } from "../../src/data/state.js";
import { newer, reconcileDoc, reconcileMetric, removedDoc } from "../../src/sync/reconcile.js";

const reset = () => {
  for (const m of [metricAll, recs, outbox]) m.clear();
  knownDocs.clear();
};
const live = (id, m, t, v, u, n) => ({ id, m, y: +t.slice(0, 4), t, v, u, ...(n ? { n } : {}) });

describe("merging remote entries", () => {
  beforeEach(() => {
    reset();
    metricAll.set("run", { name: "Running", u: 1 });
  });
  it("takes newer remote entries and keeps newer local ones", () => {
    recs.set("a", live("a", "run", "2026-01-01T10:00:00", 1, 100));
    recs.set("b", live("b", "run", "2026-01-02T10:00:00", 2, 300));
    reconcileDoc("run~2026", {
      m: "run",
      y: 2026,
      e: {
        a: { t: "2026-01-01T10:00:00", v: 5, n: null, u: 200, d: false },
        b: { t: "2026-01-02T10:00:00", v: 9, n: null, u: 250, d: false },
      },
    });
    assert.equal(recs.get("a").v, 5);
    assert.equal(recs.get("b").v, 2);
    assert.ok(outbox.has("e:run~2026:b"), "our newer copy is sent again");
  });
  it("sends entries the server lost", () => {
    recs.set("c", live("c", "run", "2026-03-01T10:00:00", 3, 100));
    reconcileDoc("run~2026", { m: "run", y: 2026, e: {} });
    assert.ok(outbox.has("e:run~2026:c"));
  });
  it("breaks ties between devices the same way everywhere", () => {
    const x = { u: 5, d: false, t: "2026-01-01T10:00:00", v: 1, n: "" };
    const y = { ...x, v: 2 };
    assert.notEqual(newer(x, y), newer(y, x));
  });
  it("removes local entries of a deleted document unless they are waiting to be sent", () => {
    recs.set("a", live("a", "run", "2026-01-01T10:00:00", 1, 100));
    recs.set("b", live("b", "run", "2026-01-02T10:00:00", 2, 100));
    outbox.set("e:run~2026:b", { k: "e:run~2026:b" });
    removedDoc("run~2026");
    assert.ok(!recs.has("a"));
    assert.ok(recs.has("b"));
  });
});

describe("deleting metrics is final", () => {
  beforeEach(reset);
  it("a deletion from elsewhere wins over a later local edit and drops queued changes", () => {
    metricAll.set("bike", { name: "Cycling", u: 500 });
    recs.set("e", live("e", "bike", "2026-01-01T10:00:00", 10, 400));
    outbox.set("e:bike~2026:e", { k: "e:bike~2026:e", kind: "e", m: "bike" });
    reconcileMetric("bike", { deleted: true, u: 300 });
    assert.equal(metricAll.get("bike").deleted, true);
    assert.equal(recs.size, 0);
    assert.equal(outbox.size, 0);
  });
  it("only a newer restore brings a deleted metric back", () => {
    metricAll.set("bike", { deleted: true, u: 300 });
    reconcileMetric("bike", { name: "Cycling", u: 200 });
    assert.equal(metricAll.get("bike").deleted, true);
    assert.ok(outbox.has("m:bike"), "the deletion is sent again");
    reconcileMetric("bike", { name: "Cycling", u: 400 });
    assert.equal(metricAll.get("bike").name, "Cycling");
  });
  it("removes orphaned year documents of a deleted metric", () => {
    metricAll.set("bike", { deleted: true, u: 300 });
    reconcileDoc("bike~2026", { m: "bike", y: 2026, e: { e: { t: "2026-01-01T10:00:00", v: 1, u: 250, d: false } } });
    assert.ok(outbox.has("x:bike~2026"));
  });
  it("deleting queues the metric tombstone and removal of its year documents", () => {
    metricAll.set("bike", { name: "Cycling", u: 1 });
    knownDocs.add("bike~2025");
    recs.set("e", live("e", "bike", "2026-01-01T10:00:00", 10, 1));
    deleteMetricOps("bike", 2);
    assert.deepEqual([...outbox.keys()].sort(), ["m:bike", "x:bike~2025", "x:bike~2026"]);
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
