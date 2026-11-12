// Preferences: text size, the version line, the privacy note and Clear Data. (Clear and Download Again, which needs
// a server, is in standalone-sync.test.js.)
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { counts, home, startHarness } from "./harness.js";

describe("preferences", () => {
  let h, P;
  const prefs = async (pg) => {
    await home(pg);
    await pg.click("#hSet");
  };

  before(async () => {
    h = await startHarness();
    P = await h.device();
  });
  after(() => h.close());

  it("text size scales the app and stays across reloads", async () => {
    const size = () => P.evaluate(() => getComputedStyle(document.querySelector("h1")).fontSize);
    const standard = parseFloat(await size());
    await prefs(P);
    await P.click('[data-text="larger"]');
    assert.equal(await P.getAttribute('[data-text="larger"]', "aria-pressed"), "true");
    await home(P);
    assert.ok(Math.abs(parseFloat(await size()) - (standard * 21) / 17) < 0.5);
    await P.reload();
    await P.waitForSelector("#cCreate");
    assert.ok(Math.abs(parseFloat(await size()) - (standard * 21) / 17) < 0.5);
    await prefs(P);
    await P.click('[data-text="standard"]');
    await home(P);
    assert.equal(parseFloat(await size()), standard);
  });

  it("shows the version and links to the source of exactly this build", async () => {
    await prefs(P);
    const line = await P.textContent(".preview.version");
    assert.match(line, /^Lokki \d+\.\d+\.\d+ · [0-9a-f]{7} · built \d{4}-\d{2}-\d{2} · Source on GitHub$/);
    assert.match(
      await P.getAttribute(".preview.version a", "href"),
      /^https:\/\/github\.com\/joakimnordling\/lokki\/tree\/[0-9a-f]{40}$/,
    );
  });

  it("explains privacy", async () => {
    await prefs(P);
    await P.click("#sPriv");
    assert.match(await P.textContent(".sheet"), /encrypted on this device/);
  });

  it("Clear Everything on a device without sync warns, offers a backup, and starts over", async () => {
    await home(P);
    await P.click("#cCreate");
    await P.fill("#mName", "Reading");
    await P.click("#mAdd");
    await home(P);
    await P.click("[data-add]");
    await P.fill("#eVal", "30");
    await P.click("#sDone");
    await prefs(P);
    await P.click('[data-text="large"]');
    await P.click("#sClr");
    assert.match(await P.textContent(".sheet"), /saved only on this device/);
    assert.ok(await P.$("#cBak"));
    assert.equal(await P.$("#cCopy"), null);
    await P.click("#cAll");
    assert.match(await P.textContent(".sheet"), /aren't saved anywhere else/);
    await Promise.all([P.waitForEvent("load"), P.click("#cYes")]);
    await P.waitForSelector("#cCreate");
    assert.match(await P.textContent("#main"), /No metrics yet/);
    assert.deepEqual(await counts(P), { live: 0 });
    assert.equal(await P.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("lokki:")).length), 0);
  });

  it("had no script errors", () => assert.deepEqual(h.errors, []));
});
