// Create Metric: your own metric, or ready-made suggestions that start in a view that suits them.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { home, startHarness } from "./harness.js";

describe("create metric", () => {
  let h, P;
  const names = () =>
    P.evaluate(() => [...window.__lokki.metricAll.values()].filter((m) => !m.deleted).map((m) => m.name));
  before(async () => {
    h = await startHarness();
    P = await h.device();
  });
  after(() => h.close());

  it("the empty screen has the button in its middle, and no other", async () => {
    assert.match(await P.textContent("#main"), /No metrics yet/);
    assert.equal(await P.locator("button.create").count(), 1);
    assert.ok(await P.$(".state #cCreate"));
    await P.click("#cCreate");
    assert.equal(await P.textContent(".sheet h3"), "Create Metric");
    await P.click("#sCancel");
  });

  it("adds your own, with a type, and opens it", async () => {
    await P.click("#cCreate");
    assert.ok(await P.$eval("#mAdd", (b) => b.disabled), "nothing to add without a name");
    assert.notEqual(await P.evaluate(() => document.activeElement?.id), "mName", "no keyboard until asked for");
    await P.fill("#mName", "Plank Seconds");
    await P.selectOption("#mType", "Fitness");
    await P.click("#mAdd");
    await P.waitForSelector("#hBack");
    assert.equal(await P.textContent("#hdr h1"), "Plank Seconds");
    const m = await P.evaluate(() => [...window.__lokki.metricAll.values()].find((x) => x.name === "Plank Seconds"));
    assert.equal(m.type, "Fitness");
  });

  it("once there are metrics, the button is at the top", async () => {
    await home(P);
    assert.equal(await P.locator("button.create").count(), 1);
    assert.equal(await P.$(".state #cCreate"), null);
  });

  it("adds suggestions with one tap each, in a view that suits them, and shows the ones you have", async () => {
    await home(P);
    await P.click("#cCreate");
    const btn = (name) => P.locator(".srow", { hasText: name }).locator("button");
    await btn("Running").click();
    await btn("Body Weight").click();
    assert.equal(await btn("Running").textContent(), "✓ Added");
    assert.ok(await btn("Running").isDisabled());
    await P.click("#sCancel");
    assert.deepEqual((await names()).sort(), ["Body Weight", "Plank Seconds", "Running"]);
    const view = (name) =>
      P.evaluate((n) => {
        const id = [...window.__lokki.metricAll].find(([, m]) => m.name === n)[0];
        return JSON.parse(localStorage.getItem(`lokki:view:${id}`));
      }, name);
    assert.deepEqual(await view("Running"), { mode: "totals", gran: "daily" });
    assert.deepEqual(await view("Body Weight"), { mode: "avg", gran: "daily" });
    // matched by name: renamed, the suggestion can be added again
    await P.click('[data-open]:has-text("Running")');
    await P.click("#hEdit");
    await P.fill("#mName", "Morning Run");
    await P.click("#sDone");
    await home(P);
    await P.click("#cCreate");
    assert.equal(await btn("Running").textContent(), "Add");
    assert.equal(await btn("Body Weight").textContent(), "✓ Added");
    await P.click("#sCancel");
  });

  it("logged no errors", () => assert.deepEqual(h.errors, []));
});
