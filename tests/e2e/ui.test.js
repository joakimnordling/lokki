// The entry list, and the unbundled modules (index.html) running on their own.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { makeData } from "./fixtures.js";
import { counts, startHarness } from "./harness.js";

describe("entry list", () => {
  let h, A;
  const first = () => A.evaluate(() => document.querySelector(".er .open")?.textContent.replace(/\s+/g, " "));
  before(async () => {
    h = await startHarness();
    h.seed(await makeData());
    A = await h.device();
    await A.click("text=Running");
    await A.click("#nList");
  });
  after(() => h.close());

  it("deletes an entry and brings it back with Undo", async () => {
    const f0 = await first();
    await A.click("#eEdit");
    await A.click('[data-minus="0"]');
    await A.click('[data-del="0"]');
    await A.waitForTimeout(300);
    assert.notEqual(await first(), f0);
    await A.click(".toast button");
    await A.waitForTimeout(300);
    assert.equal(await first(), f0);
  });

  it("edits the value and note, sent as a one-entry update", async () => {
    await A.click("#eDone");
    await A.click('[data-open="0"]');
    await A.fill("#eVal", "4,6");
    await A.fill("#eNote", "test note");
    await A.click("#sDone");
    await A.waitForTimeout(500);
    assert.match(await first(), /4,6.*test note|test note.*4,6/);
    assert.equal(h.writes.at(-1).op, "update");
    assert.equal(h.writes.at(-1).keys, 1);
  });

  it("searches entries", async () => {
    await A.fill("#eq", "test note");
    await A.waitForTimeout(100);
    assert.equal(await A.$$eval(".er", (r) => r.length), 1);
  });

  it("had no script errors", () => assert.deepEqual(h.errors, []));
});

describe("unbundled modules", () => {
  let h, D;
  const requests = [];
  before(async () => {
    h = await startHarness();
    h.seed(await makeData());
    D = await h.device("/dev/", { wait: 0 });
    D.on("request", (r) => requests.push(r.url()));
    await D.reload();
    await D.waitForTimeout(1500);
  });
  after(() => h.close());

  it("load, sync and log an entry", async () => {
    const n = (await counts(D)).live;
    assert.ok(n > 1000);
    await D.click('[data-add="running"]');
    await D.fill("#eVal", "1+1");
    await D.click("#sDone");
    await D.waitForTimeout(600);
    assert.equal((await counts(D)).live, n + 1);
    assert.equal(h.writes.at(-1).op, "update");
  });

  it("use the self-hosted font and request nothing from elsewhere", async () => {
    assert.ok(await D.evaluate(async () => (await document.fonts.ready) && document.fonts.check('16px "Jost"')));
    assert.ok(requests.some((u) => u.endsWith("/fonts/jost-latin-wght-normal.woff2")));
    assert.deepEqual(
      requests.filter((u) => !u.startsWith(h.base)),
      [],
    );
  });

  it("had no script errors", () => assert.deepEqual(h.errors, []));
});
