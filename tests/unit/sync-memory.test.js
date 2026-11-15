// The in-memory device (packages/sync/memory.js): local changes go through the app's merge.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sameRecord } from "../../packages/sync/crypto.js";
import { MemoryDevice } from "../../packages/sync/memory.js";

// A field-by-field merge that always builds a new object
const merge = (r, l) => ({ ...l, ...r, text: r.tu >= l.tu ? r.text : l.text, tu: Math.max(r.tu, l.tu) });

describe("the in-memory device", () => {
  it("keeps a record's server bits when a merge gives back what it had, as a new object", async () => {
    const d = new MemoryDevice({ merge });
    const note = { kind: "note", id: "n1", text: "hello", tu: 2 };
    await d.apply([note], 0);
    assert.equal(d.pending(0).length, 0);
    assert.equal(d.put({ ...note, text: "older", tu: 1 }), false, "nothing new");
    assert.equal(d.pending(0).length, 0, "not pushed again");
    assert.equal(d.put({ ...note, text: "newer", tu: 3 }), true);
    assert.deepEqual(d.pending(0), [{ ...note, text: "newer", tu: 3 }]);
  });

  it("tells versions apart by value, whatever order their fields are in", () => {
    assert.ok(sameRecord({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 }));
    assert.ok(!sameRecord({ a: 1 }, { a: 2 }));
    assert.ok(!sameRecord({ a: 1 }, null));
  });
});
