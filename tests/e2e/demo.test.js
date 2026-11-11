// The demo (?demo): a year of made-up logs in a database of its own, never synced, made afresh on every open and
// wiped on closing, while the person's own logs and settings stay as they were.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { counts, home, ready, startHarness } from "./harness.js";

// What the page's origin keeps outside the demo: the real database's records, and the lokki: settings
const own = (pg) =>
  pg.evaluate(async () => {
    const db = await new Promise((ok, ko) => {
      const r = indexedDB.open("lokki");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    });
    const all = (s) =>
      new Promise((ok) => {
        const r = db.transaction(s).objectStore(s).getAll();
        r.onsuccess = () => ok(r.result);
      });
    const out = { recs: (await all("recs")).length, metrics: (await all("metrics")).map((m) => m.name) };
    db.close();
    out.settings = Object.keys(localStorage)
      .filter((k) => k.startsWith("lokki:"))
      .sort();
    out.demoSettings = Object.keys(localStorage).filter((k) => k.startsWith("lokki-demo:"));
    return out;
  });
const demoRecs = (pg) =>
  pg.evaluate(
    () =>
      new Promise((ok) => {
        const r = indexedDB.open("lokki-demo");
        r.onsuccess = () => {
          const g = r.result.transaction("recs").objectStore("recs").count();
          g.onsuccess = () => {
            r.result.close();
            ok(g.result);
          };
        };
      }),
  );

describe("demo", () => {
  let h, P;
  before(async () => {
    h = await startHarness();
    P = await h.device();
  });
  after(() => h.close());

  it("the empty screen offers it, and it opens with a year of logs", async () => {
    await P.click("#cDemo");
    await P.waitForSelector('[data-open="running"]');
    assert.match(P.url(), /\?demo$/);
    assert.match(await P.textContent(".note.demo"), /made-up logs/);
    assert.ok((await counts(P)).live > 2000);
    // no sync in the demo
    await P.click("#hSet");
    assert.equal(await P.$("#sSync"), null);
    assert.ok(await P.$("#sDemo"));
    assert.equal(await P.$("#sShowDemo"), null);
  });

  it("changes in the demo stay in the demo, and Start Over makes it afresh", async () => {
    await home(P);
    const before = (await counts(P)).live;
    await P.click('[data-add="coffee"]');
    await P.fill("#eVal", "9");
    await P.click("#sDone");
    await P.waitForFunction((n) => {
      const L = window.__lokki;
      return [...L.recs.values()].filter((r) => !r.d).length === n;
    }, before + 1);
    await P.click("#hSet");
    await P.click('[data-text="larger"]');
    await home(P);
    const o = await own(P);
    assert.deepEqual([o.recs, o.metrics, o.settings], [0, [], []]);
    assert.ok(o.demoSettings.includes("lokki-demo:text"));

    await P.click("#dAgain");
    await P.waitForSelector('[data-open="running"]');
    assert.equal((await counts(P)).live, before);
    assert.ok(!(await own(P)).demoSettings.includes("lokki-demo:text"), "the demo's settings start over too");
  });

  it("Close Demo wipes it and goes back to your own logs", async () => {
    await Promise.all([P.waitForURL((u) => !u.search), P.click("#dClose")]);
    await ready(P);
    assert.equal((await counts(P)).live, 0);
    assert.equal(await demoRecs(P), 0);
    assert.deepEqual((await own(P)).demoSettings, []);
  });

  it("a device with logs keeps them, and offers the demo from Preferences in a new tab", async () => {
    await P.click("#cCreate");
    await P.fill("#mName", "Reading");
    await P.click("#sDone");
    await P.click("[data-add]");
    await P.fill("#eVal", "30");
    await P.click("#sDone");
    await home(P);
    assert.equal(await P.$("#cDemo"), null, "only an empty screen offers it");
    await P.click("#hSet");
    const [tab] = await Promise.all([P.context().waitForEvent("page"), P.click("#sShowDemo")]);
    await tab.waitForSelector('[data-open="running"]');
    assert.match(tab.url(), /\?demo$/);
    await Promise.all([tab.waitForURL((u) => !u.search), tab.click("#dClose")]);
    await ready(tab);
    // the person's own logs, untouched
    assert.equal((await counts(tab)).live, 1);
    assert.deepEqual((await own(tab)).metrics, ["Reading"]);
    await tab.close();
  });

  it("logged no errors", () => assert.deepEqual(h.errors, []));
});
