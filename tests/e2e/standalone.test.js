// The built site (GitHub Pages) without sync: everything stays on the device.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { home, startHarness, toastText } from "./harness.js";

describe("standalone site", () => {
  let h, P, dir;
  const requests = [];
  const download = async (pg, click) => {
    const [d] = await Promise.all([pg.waitForEvent("download"), click()]);
    const f = join(dir, d.suggestedFilename());
    await d.saveAs(f);
    return { name: d.suggestedFilename(), f };
  };

  before(async () => {
    h = await startHarness();
    dir = await mkdtemp(join(tmpdir(), "lokki-"));
    P = await h.device();
    P.on("request", (r) => requests.push(r.url()));
    await P.reload();
    await P.waitForSelector("#cCreate");
  });
  after(() => h.close());

  it("opens ready to use", async () => {
    assert.match(await P.textContent("#main"), /No metrics yet/);
  });

  it("logs entries and keeps them across reloads", async () => {
    await P.click("#cCreate");
    await P.fill("#mName", "Running");
    await P.click("#mAdd");
    await home(P);
    await P.click("[data-add]");
    await P.fill("#eVal", "2+0,5");
    await P.click("#sDone");
    await P.waitForTimeout(300);
    await P.reload();
    await P.waitForSelector("[data-add]");
    assert.equal(await P.textContent("[data-add]"), "2,5");
    assert.match(await P.textContent("#main"), /Saved on this device only/);
    await P.click("#hSet");
    assert.match(await P.textContent(".sheet .preview"), /1 metrics · 1 entries\. Saved on this device only\./);
  });

  let backup;
  it("saves backups and CSV exports as ordinary downloads", async () => {
    await home(P);
    await P.click("#hSet");
    backup = await download(P, () => P.click("#sBak"));
    assert.match(backup.name, /^lokki-backup-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
    await home(P);
    await P.click("#hSet");
    const csv = await download(P, () => P.click("#sExp"));
    assert.match(csv.name, /^lokki-export-.*\.csv$/);
  });

  it("restores the backup on another device", async () => {
    const Q = await h.device();
    await Q.click("#hSet");
    const [chooser] = await Promise.all([Q.waitForEvent("filechooser"), Q.click("#sRes")]);
    await chooser.setFiles(backup.f);
    await Q.waitForSelector("#sDone");
    await Q.click("#sDone");
    await toastText(Q, /Restored/);
    assert.equal(await Q.textContent("[data-add]"), "2,5");
  });

  it("works offline once it has been opened", async () => {
    await P.evaluate(() => navigator.serviceWorker.ready);
    await P.reload(); // now controlled by the service worker
    await P.context().setOffline(true);
    await P.reload();
    await P.waitForSelector("[data-add]");
    assert.equal(await P.textContent("[data-add]"), "2,5");
    assert.ok(await P.evaluate(() => document.fonts.check('16px "Jost"')));
    await P.context().setOffline(false);
  });

  it("requests nothing from elsewhere", () => {
    assert.deepEqual(
      requests.filter((u) => !u.startsWith(h.base) && !u.startsWith("blob:")),
      [],
    );
  });

  it("opens a copy saved by an older version, whose database still has the claude.ai outbox", async () => {
    const ctx = await h.browser.newContext();
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => h.errors.push(e.message));
    await pg.goto(`${h.base}/site/manifest.webmanifest`); // the app's origin, without starting the app
    await pg.evaluate(
      () =>
        new Promise((done, failed) => {
          const r = indexedDB.open("lokki", 2);
          r.onupgradeneeded = () => {
            for (const [n, k] of [
              ["recs", "id"],
              ["metrics", "id"],
              ["outbox", "k"],
              ["sync", "k"],
            ])
              r.result.createObjectStore(n, { keyPath: k });
          };
          r.onsuccess = () => {
            const tx = r.result.transaction(["recs", "metrics", "outbox"], "readwrite");
            tx.objectStore("metrics").put({ id: "swim", name: "Swimming", type: "", created: "", u: 1 });
            tx.objectStore("recs").put({ id: "e1", m: "swim", y: 2026, t: "2026-11-01T10:00:00", v: 1.5, u: 2 });
            tx.objectStore("outbox").put({ k: "e:swim~2026:e1", kind: "e", seq: 1 });
            tx.oncomplete = () => {
              r.result.close();
              done();
            };
            tx.onerror = () => failed(tx.error);
          };
        }),
    );
    await pg.goto(`${h.base}/site/`);
    await pg.waitForSelector('[data-add="swim"]');
    assert.equal(await pg.textContent('[data-add="swim"]'), "1,5");
    const stores = await pg.evaluate(() => [...window.__lokki.idb.db.objectStoreNames].sort());
    assert.deepEqual(stores, ["metrics", "recs", "sync"]);
    await ctx.close();
  });

  it("had no script errors", () => assert.deepEqual(h.errors, []));
});
