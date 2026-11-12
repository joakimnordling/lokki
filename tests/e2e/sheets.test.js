// Sheets keep the page behind them still: it doesn't scroll under a sheet, and is back where it was afterwards.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startHarness } from "./harness.js";

describe("sheets", () => {
  let h, P;
  before(async () => {
    h = await startHarness();
    P = await h.device("/site/?demo", { viewport: { width: 393, height: 500 } });
    await P.waitForSelector('[data-open="running"]');
  });
  after(() => h.close());

  it("pins the page while a sheet is open, and puts it back where it was", async () => {
    await P.evaluate(() => window.scrollTo(0, 200));
    const top = () => P.$eval('[data-open="coffee"]', (e) => Math.round(e.getBoundingClientRect().top));
    const before = await top();
    await P.click("#hSet");
    assert.equal(await P.evaluate(() => getComputedStyle(document.body).position), "fixed");
    assert.equal(await top(), before, "the page didn't jump when it was pinned");
    // a wheel over the sheet's edge scrolls nothing behind it
    await P.mouse.move(200, 60);
    await P.mouse.wheel(0, 400);
    await P.waitForTimeout(200);
    assert.equal(await top(), before);
    await P.click("#sCancel");
    assert.equal(await P.evaluate(() => getComputedStyle(document.body).position), "static");
    assert.equal(await P.evaluate(() => Math.round(window.scrollY)), 200);
    assert.equal(await top(), before);
  });

  it("logged no errors", () => assert.deepEqual(h.errors, []));
});
