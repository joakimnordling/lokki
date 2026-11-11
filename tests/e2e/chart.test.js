// The chart: few points are spread over the whole plot, as in the old Loggr app; many scroll.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { home, startHarness } from "./harness.js";

describe("chart", () => {
  let h, P;
  const p2 = (x) => String(x).padStart(2, "0");
  // A metric with one entry a day, n days up to Nov 10 2026, worth 1, 2, 3...
  const metric = (n) => {
    const ops = [["metrics", "put", { id: `n${n}`, name: `Points ${n}`, created: "2026-01-01T08:00:00", u: 1 }]];
    for (let i = 0; i < n; i++) {
      const d = new Date(2026, 10, 10 - (n - 1 - i));
      const t = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T08:00:00`;
      ops.push(["recs", "put", { id: `n${n}.${i}`, m: `n${n}`, y: 2026, t, v: i + 1, u: 2 + i }]);
    }
    return ops;
  };
  const open = async (n, mode) => {
    await home(P);
    await P.click(`[data-open="n${n}"]`);
    await P.click('[data-mode="totals"]');
    await P.click('[data-gran="daily"]');
    await P.click(`[data-mode="${mode}"]`);
  };
  const scrolls = () => P.$eval("#chart", (c) => c.scrollWidth > c.clientWidth);
  // Clicks the chart at a fraction of its plot's width, and returns the value then shown for the selected point
  const pickAt = async (f) => {
    const box = await (await P.$("#chart")).boundingBox();
    await P.mouse.click(box.x + 10 + f * (box.width - 42 - 20), box.y + box.height / 2);
    return (await P.textContent(".nav .val")).trim();
  };

  before(async () => {
    h = await startHarness();
    P = await h.device();
    await P.evaluate((ops) => window.__lokki.idb.write(ops), [...metric(3), ...metric(200)]);
    await P.reload();
    await P.waitForSelector('[data-open="n3"]');
  });
  after(() => h.close());

  it("spreads a few bars, and a few points of a line, over the whole width", async () => {
    for (const mode of ["totals", "avg", "all"]) {
      await open(3, mode);
      assert.equal(await scrolls(), false, mode);
    }
    // the bars side by side: clicking the left, middle and right thirds picks the first, second and third
    await open(3, "totals");
    assert.deepEqual([await pickAt(0.1), await pickAt(0.5), await pickAt(0.9)], ["1", "2", "3"]);
  });

  it("scrolls when there are more than fit", async () => {
    for (const mode of ["totals", "avg", "all"]) {
      await open(200, mode);
      assert.equal(await scrolls(), true, mode);
    }
  });

  it("logged no errors", () => assert.deepEqual(h.errors, []));
});
