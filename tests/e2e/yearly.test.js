// Yearly: offered once a metric's first entry is two years old, remembered per metric like the other choices, and
// Monthly (saved) when a metric can't have it.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { home, startHarness } from "./harness.js";

describe("yearly view", () => {
  let h, P;
  const p2 = (x) => String(x).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T08:00:00`;
  const now = new Date();
  // An entry worth 1 on the 1st of every month, from `months` months ago up to now
  const metric = (id, months) => {
    const ops = [["metrics", "put", { id, name: id, created: "2020-01-01T08:00:00", u: 1 }]];
    for (let i = months; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      ops.push(["recs", "put", { id: `${id}.${i}`, m: id, y: d.getFullYear(), t: iso(d), v: 1, u: 2 + months - i }]);
    }
    return ops;
  };
  const open = async (id) => {
    await home(P);
    await P.click(`[data-open="${id}"]`);
    await P.waitForSelector("#chart");
  };
  const grans = () => P.$$eval("[data-gran]", (bs) => bs.map((b) => b.dataset.gran));
  const chosen = () => P.$eval('[data-gran][aria-pressed="true"]', (b) => b.dataset.gran);
  const saved = (id) => P.evaluate((k) => JSON.parse(localStorage.getItem(k))?.gran, `lokki:view:${id}`);

  before(async () => {
    h = await startHarness();
    P = await h.device();
    // Old: five years of entries. Young: a year and a half.
    await P.evaluate((ops) => window.__lokki.idb.write(ops), [...metric("Old", 60), ...metric("Young", 18)]);
    await P.reload();
    await P.waitForSelector('[data-open="Old"]');
  });
  after(() => h.close());

  it("is offered for a metric with two years of entries, with the latest year selected", async () => {
    await open("Old");
    assert.deepEqual(await grans(), ["daily", "weekly", "monthly", "yearly"]);
    await P.click('[data-mode="totals"]');
    await P.click('[data-gran="yearly"]');
    assert.equal(await chosen(), "yearly");
    assert.equal((await P.textContent(".nav .lbl")).trim(), String(now.getFullYear()));
    // One entry a month this year so far: the year's total
    assert.equal(await P.$eval(".nav .val", (v) => v.firstChild.textContent), String(now.getMonth() + 1));
    assert.equal(await saved("Old"), "yearly");
  });

  it("isn't offered for a younger metric, which opens Monthly after Yearly and keeps it", async () => {
    await open("Young");
    assert.deepEqual(await grans(), ["daily", "weekly", "monthly"]);
    assert.equal(await chosen(), "monthly");
    assert.equal(await saved("Young"), "monthly");
  });

  it("is remembered per metric", async () => {
    await open("Old");
    assert.equal(await chosen(), "yearly");
  });

  it("falls back to Monthly, saved, once a metric no longer has two years", async () => {
    const old = [];
    for (let i = 60; i > 12; i--) old.push(["recs", "delete", `Old.${i}`]);
    await P.evaluate((ops) => window.__lokki.idb.write(ops), old);
    await P.reload();
    await P.waitForSelector('[data-open="Old"]');
    await open("Old");
    assert.deepEqual(await grans(), ["daily", "weekly", "monthly"]);
    assert.equal(await chosen(), "monthly");
    assert.equal(await saved("Old"), "monthly");
  });

  it("logged no errors", () => assert.deepEqual(h.errors, []));
});
