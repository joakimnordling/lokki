// Two devices syncing through the (simulated) claude.ai database: offline changes, conflicts, deletions.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { stats } from "../../src/core/stats.js";
import { makeData, oldLoggrFiles } from "./fixtures.js";
import { counts, pick, startHarness, toastText } from "./harness.js";

describe("sync between two devices", () => {
  let h, data, A, B, N;
  const docOf = (e, m = e.m) => h.store["entries-v2"].get(`${m}~${e.t.slice(0, 4)}`);
  const online = async (pg) =>
    pg.evaluate(() => {
      window.__setOffline(false);
      window.__lokki.flush();
    });
  const offline = (pg) => pg.evaluate(() => window.__setOffline(true));

  before(async () => {
    h = await startHarness();
    data = await makeData();
    N = data.entries.length;
    h.seed(data);
    A = await h.device();
    B = await h.device();
  });
  after(() => h.close());

  it("both devices load every entry without writing anything", async () => {
    assert.equal((await counts(A)).live, N);
    assert.equal((await counts(B)).live, N);
    assert.equal(h.writes.length, 0);
  });

  it("computes the same totals and statistics as the data", async () => {
    const run = data.entries.filter((e) => e.m === "running").reduce((a, e) => a + e.v, 0);
    const got = await A.evaluate(() => window.__lokki.series("running", "all", "daily").reduce((a, x) => a + x.v, 0));
    assert.equal(Math.round(got * 100), Math.round(run * 100));
    const s = stats(data.entries.filter((e) => e.m === "body-weight").map((e) => e.v));
    const g = await A.evaluate(() => {
      const L = window.__lokki;
      return L.stats(L.series("body-weight", "all", "daily").map((x) => x.v));
    });
    assert.deepEqual(g, s);
  });

  it("an entry added on A shows up on B, sent as a one-entry update", async () => {
    await A.click('[data-add="running"]');
    await A.fill("#eVal", "2,5");
    await A.click("#sDone");
    await A.waitForTimeout(800);
    assert.equal((await counts(B)).live, N + 1);
    assert.deepEqual(h.writes.at(-1), {
      op: "update",
      path: `entries-v2/running~${new Date().getFullYear()}`,
      keys: 1,
    });
  });

  let moved, victim;
  it("changes made offline survive a reload", async () => {
    await offline(B);
    moved = await pick(B, "reading", 5);
    victim = await pick(B, "reading", 6);
    await B.click('[data-add="cycling"]');
    await B.fill("#eVal", "12");
    await B.click("#sDone");
    await B.evaluate(
      async ([m, v]) => {
        await window.__test.edit({ id: m.id }, "2013-12-31T23:00:00", m.v, "moved year");
        window.__test.del({ id: v.id });
      },
      [moved, victim],
    );
    await B.waitForTimeout(300);
    await B.goto(`${h.base}/#off`);
    await B.reload();
    await B.waitForTimeout(11000); // the app gives up waiting for the server after 10 s
    assert.ok((await counts(B)).outbox >= 3);
    assert.match(await B.textContent("#main"), /waiting to sync/);
  });

  it("they are sent once back online", async () => {
    await online(B);
    await B.waitForFunction(() => window.__lokki.outbox.size === 0, null, { timeout: 15000 });
    await B.waitForTimeout(500);
    assert.equal((await counts(A)).live, N + 1); // +1 added, -1 deleted
    const m = await A.evaluate((id) => window.__lokki.recs.get(id), moved.id);
    assert.equal(m.y, 2013);
    assert.equal(m.n, "moved year");
    assert.ok(!m.d);
  });

  it("deleted and moved entries leave markers without values on the server", () => {
    assert.deepEqual(docOf(moved).e[moved.id], { t: null, v: null, n: null, u: docOf(moved).e[moved.id].u, d: true });
    assert.deepEqual(docOf(victim).e[victim.id], {
      t: null,
      v: null,
      n: null,
      u: docOf(victim).e[victim.id].u,
      d: true,
    });
  });

  it("offline additions to the same year from two devices both survive", async () => {
    await offline(A);
    await offline(B);
    await A.evaluate(() => window.__test.add("running", "2026-11-07T10:00:00", 1.1, ""));
    await B.evaluate(() => window.__test.add("running", "2026-11-07T11:00:00", 2.2, ""));
    await online(A);
    await A.waitForTimeout(600);
    await online(B);
    await B.waitForTimeout(900);
    assert.equal((await counts(A)).live, N + 3);
    assert.equal((await counts(B)).live, N + 3);
  });

  let same;
  it("when both edit the same entry offline, the later edit wins everywhere", async () => {
    same = await pick(A, "body-weight", 10);
    await offline(A);
    await offline(B);
    await A.evaluate((s) => window.__test.edit({ id: s.id }, s.t, 70, "from A"), same);
    await A.waitForTimeout(30);
    await B.evaluate((s) => window.__test.edit({ id: s.id }, s.t, 71, "from B (later)"), same);
    await online(B);
    await B.waitForTimeout(500);
    await online(A); // A syncs last, but its edit is older
    await A.waitForTimeout(1200);
    const get = (pg) => pg.evaluate((id) => window.__lokki.recs.get(id).v, same.id);
    assert.equal(await get(A), 71);
    assert.equal(await get(B), 71);
    assert.equal(docOf(same).e[same.id].v, 71);
  });

  it("clearing a note clears it on the server and the other device", async () => {
    await A.evaluate((s) => window.__test.edit({ id: s.id }, s.t, 71, ""), same);
    await A.waitForTimeout(600);
    assert.equal(docOf(same).e[same.id].n, null);
    assert.equal((await B.evaluate((id) => window.__lokki.recs.get(id).n, same.id)) ?? null, null);
  });

  it("Undo after a delete brings the entry back on both devices", async () => {
    const before = (await counts(A)).live;
    await A.evaluate((s) => {
      window.__old = window.__test.del({ id: s.id });
    }, same);
    await A.waitForTimeout(300);
    await A.evaluate(() => window.__test.restore(window.__old));
    await A.waitForTimeout(700);
    const back = await B.evaluate((id) => window.__lokki.recs.get(id), same.id);
    assert.ok(!back.d);
    assert.equal(back.v, 71);
    assert.equal((await counts(A)).live, before);
  });

  it("importing the old Loggr CSV files again adds nothing and doesn't bring back deleted entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lokki-"));
    const files = [];
    for (const [name, text] of oldLoggrFiles(data.entries)) {
      files.push(join(dir, name));
      await writeFile(files.at(-1), text);
    }
    const before = (await counts(A)).live;
    await A.click("#hSet");
    const [chooser] = await Promise.all([A.waitForEvent("filechooser"), A.click("#sImp")]);
    await chooser.setFiles(files);
    assert.match(await toastText(A, /Imported|Nothing new/), /Nothing new to import/);
    assert.equal((await counts(A)).live, before);
  });

  it("deleting a metric removes it on the other device and on the server", async () => {
    await A.evaluate(() => window.__test.delMetric("gym"));
    await A.waitForTimeout(1200);
    assert.equal(await B.evaluate(() => [...window.__lokki.recs.values()].filter((r) => r.m === "gym").length), 0);
    assert.ok(![...h.store["entries-v2"].keys()].some((k) => k.startsWith("gym~")));
  });

  it("a deletion is final even for a device that was offline with unsent changes", async () => {
    await offline(B);
    await B.evaluate(() => window.__test.add("cycling", "2026-11-07T13:00:00", 20, "offline"));
    await A.evaluate(() => window.__test.delMetric("cycling"));
    await A.waitForTimeout(800);
    const left = () => [...h.store["entries-v2"].keys()].some((k) => k.startsWith("cycling~"));
    assert.ok(!left());
    await online(B);
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && left()) await B.waitForTimeout(250);
    await B.waitForTimeout(1500);
    assert.ok(!left(), "no Cycling data is left on the server");
    assert.equal(
      await B.evaluate(
        () => [...window.__lokki.outbox.values()].filter((i) => i.m === "cycling" || i.id === "cycling").length,
      ),
      0,
    );
    assert.equal(h.store.metrics.get("cycling").deleted, true);
    assert.equal(await B.evaluate(() => window.__lokki.metricAll.get("cycling").deleted), true);
  });

  it("had no script errors", () => assert.deepEqual(h.errors, []));
});
