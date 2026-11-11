// The rank list's left edge.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startHarness } from "./harness.js";

describe("rank list", () => {
  let h, P;
  before(async () => {
    h = await startHarness();
    P = await h.device();
    await P.waitForSelector("#cCreate");
  });
  after(() => h.close());

  it("starts at the left edge like the other lists, with the positions' column as wide as needed", async () => {
    await P.click("#cCreate");
    await P.fill("#mName", "Reading");
    await P.click("#sDone");
    const mid = await P.evaluate(() => [...window.__lokki.metricAll.keys()][0]);
    for (let m = 1; m <= 12; m++)
      await P.evaluate(
        ([id, m]) => window.__test.add(id, `2025-${String(m).padStart(2, "0")}-15T08:00:00`, m * 3, ""),
        [mid, m],
      );
    await P.click("[data-open]");
    const gap = () =>
      P.evaluate(() => {
        const row = document.querySelector(".li.rank");
        const pos = row.querySelector(".pos");
        // empty space before the position's text, inside its column
        const range = document.createRange();
        range.selectNodeContents(pos);
        return range.getBoundingClientRect().left - row.getBoundingClientRect().left;
      });
    const label = () =>
      P.evaluate(() => document.querySelector(".li.rank span:nth-child(2)").getBoundingClientRect().left);
    assert.ok((await gap()) < 1, `starts ${await gap()} px from the edge`);
    const short = await label();
    await P.click('[data-rstep="1"]'); // ten positions: "10." is the widest
    assert.ok((await gap()) < 1, `with two-digit positions, starts ${await gap()} px from the edge`);
    assert.ok((await label()) > short, "the labels make room for two-digit positions");
  });
});
