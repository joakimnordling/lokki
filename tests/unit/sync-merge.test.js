import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareEntries, compareMetrics } from "../../src/sync/merge.js";

const entry = (u, extra = {}) => ({
  kind: "entry",
  id: "e",
  metric: "m",
  t: "2026-01-01T10:00:00",
  v: 1,
  n: null,
  u,
  d: false,
  ...extra,
});
const metric = (u, g, deleted = false, extra = {}) => ({
  kind: "metric",
  id: "m",
  name: deleted ? null : "Running",
  u,
  g,
  deleted,
  ...extra,
});

describe("entries", () => {
  it("the newer one wins", () => {
    assert.ok(compareEntries(entry(2), entry(1)) > 0);
    assert.ok(compareEntries(entry(1, { d: true, t: null, v: null }), entry(2)) < 0);
    assert.equal(compareEntries(entry(1), entry(1)), 0);
  });
  it("ties are broken the same way whichever side looks", () => {
    const a = entry(5, { v: 1 });
    const b = entry(5, { v: 2 });
    assert.equal(Math.sign(compareEntries(a, b)), -Math.sign(compareEntries(b, a)));
    assert.notEqual(compareEntries(a, b), 0);
  });
});

describe("metrics", () => {
  const tombstone = metric(100, 100, true);
  it("a deletion beats a later edit from before it", () => {
    assert.ok(compareMetrics(tombstone, metric(200, 0)) > 0);
  });
  it("a restore beats the deletion it follows, and a newer deletion beats the restore", () => {
    const restore = metric(300, 100);
    assert.ok(compareMetrics(restore, tombstone) > 0);
    assert.ok(compareMetrics(metric(400, 400, true), restore) > 0);
  });
  it("compares numbers as numbers", () => {
    assert.ok(compareMetrics(metric(100, 0), metric(99, 0)) > 0);
    assert.ok(compareMetrics(metric(1, 100, true), metric(1, 99, true)) > 0);
  });
  it("orders consistently, whatever the order of comparison", () => {
    const versions = [
      metric(300, 0),
      tombstone,
      metric(150, 100),
      metric(400, 400, true),
      metric(300, 0, false, { name: "Run" }),
    ];
    const sorted = (list) => [...list].sort(compareMetrics).map((m) => JSON.stringify(m));
    assert.deepEqual(sorted(versions), sorted([...versions].reverse()));
  });
});
