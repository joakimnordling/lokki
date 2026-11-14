// Records a server has a newer Lokki's version of (ub, src/sync/device.js): editing them here keeps that mark, so
// this device's version is never pushed over the newer one; a server that's removed takes its marks with it.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startHarness } from "./harness.js";

describe("records with a newer version on a server", () => {
  let h, P;
  before(async () => {
    h = await startHarness();
    P = await h.device();
  });
  after(() => h.close());

  it("keep their mark through local changes, and aren't offered for pushing to that server", async () => {
    const result = await P.evaluate(async () => {
      const L = window.__lokki,
        T = window.__test;
      await L.idb.write([
        ["metrics", "put", { id: "run", name: "Running", type: "", created: "", u: 1, g: 0, sb: 3, ub: 2 }],
        ["recs", "put", { id: "a", m: "run", y: 2026, t: "2026-01-01T10:00:00", v: 5, u: 10, sb: 3, ub: 2 }],
      ]);
      L.metricAll.set("run", { name: "Running", type: "", created: "", u: 1, g: 0, sb: 3, ub: 2 });
      L.recs.set("a", { id: "a", m: "run", y: 2026, t: "2026-01-01T10:00:00", v: 5, u: 10, sb: 3, ub: 2 });
      await T.edit(L.recs.get("a"), "2026-01-01T10:00:00", 6);
      const d = L.sync.device;
      const pending = (bit) =>
        d
          .pending(bit)
          .map((r) => r.id)
          .sort();
      const out = { edited: [L.recs.get("a").sb, L.recs.get("a").ub], to0: pending(0), to1: pending(1) };
      d.markHas("entry", "a", 1); // that server now has a version this device reads
      out.cleared = L.recs.get("a").ub ?? 0;
      d.markUnreadable("entry", "a", 1);
      d.clearBit(1); // the server is removed
      out.removed = L.recs.get("a").ub ?? 0;
      return out;
    });
    assert.deepEqual(result, {
      edited: [0, 2],
      to0: ["a"],
      to1: [],
      cleared: 0,
      removed: 0,
    });
  });

  it("logged no errors", () => assert.deepEqual(h.errors, []));
});
