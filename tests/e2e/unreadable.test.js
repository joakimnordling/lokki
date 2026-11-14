// Rows a server holds in a format this device can't read (a newer Lokki's): kept by row name in the sync store, so
// they survive a restart and nothing is pushed over them (protocol 7.5, src/sync/device.js).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startHarness } from "./harness.js";

describe("rows from a newer Lokki", () => {
  let h, P;
  before(async () => {
    h = await startHarness();
    P = await h.device();
  });
  after(() => h.close());
  const stored = () =>
    P.evaluate(async () =>
      (await window.__lokki.idb.all("sync")).filter((r) => r.k.startsWith("unreadable:")).map((r) => [r.k, r.bits]),
    );

  it("are saved with the servers' state, read back after a restart, and go with their server", async () => {
    await P.evaluate(async () => {
      const d = window.__lokki.sync.device;
      d.markUnreadable("rowA", 0);
      d.markUnreadable("rowA", 2);
      d.markUnreadable("rowB", 1);
      await d.persist();
    });
    assert.deepEqual((await stored()).sort(), [
      ["unreadable:rowA", 5],
      ["unreadable:rowB", 2],
    ]);
    await P.reload();
    await P.waitForSelector("#cCreate");
    assert.deepEqual(
      await P.evaluate(() => ["rowA", "rowB", "rowC"].map((k) => window.__lokki.sync.device.unreadable(k))),
      [5, 2, 0],
    );
    await P.evaluate(async () => {
      const d = window.__lokki.sync.device;
      d.clearUnreadable("rowB", 1); // that server sent a row this device reads
      d.clearBit(2); // a server removed
      await d.persist();
    });
    assert.deepEqual(await stored(), [["unreadable:rowA", 1]]);
  });

  it("are saved when a server is renamed mid-sync, since its cursor is saved then too", async () => {
    await P.evaluate(async () => {
      const s = window.__lokki.sync;
      s.servers.push({ k: "server:3", bit: 3, url: "https://sync.example.com", token: "t", cursor: 9, name: "Old" });
      s.device.markUnreadable("rowD", 3); // only in memory, as during a sync
      await s.updateServer(3, { name: "New" });
    });
    assert.deepEqual(
      (await stored()).filter(([k]) => k === "unreadable:rowD"),
      [["unreadable:rowD", 8]],
    );
  });

  it("logged no errors", () => assert.deepEqual(h.errors, []));
});
