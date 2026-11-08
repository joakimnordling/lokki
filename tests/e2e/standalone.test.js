// The built site (GitHub Pages) running on its own, without claude.ai: everything stays on the device.
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
    P = await h.device("/site/", { claude: false, wait: 0 });
    P.on("request", (r) => requests.push(r.url()));
    await P.reload();
    await P.waitForSelector("#cCreate");
  });
  after(() => h.close());

  it("opens ready to use, without asking to sign in", async () => {
    const text = await P.textContent("#main");
    assert.doesNotMatch(text, /Sign in|claude\.ai/);
    assert.match(text, /No metrics yet/);
  });

  it("logs entries and keeps them across reloads", async () => {
    await P.click("#cCreate");
    await P.fill("#mName", "Running");
    await P.click("#sDone");
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
    const Q = await h.device("/site/", { claude: false });
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

  it("had no script errors", () => assert.deepEqual(h.errors, []));
});
