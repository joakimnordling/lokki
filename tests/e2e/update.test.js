// Noticing a new version of the standalone app.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { home, startHarness } from "./harness.js";

describe("updates", () => {
  let h, P;
  const newer = { version: "0.1.0", commit: "f".repeat(40), built: "2099-01-01" };
  // Serve version.json as a newer deploy (or failing, with null) until changed again
  const deploy = async (info) => {
    // on the context, so it also catches the service worker's requests
    await P.context().unroute("**/version.json");
    await P.context().route("**/version.json", (r) =>
      info ? r.fulfill({ json: info, headers: { "cache-control": "no-store" } }) : r.abort(),
    );
  };
  const restart = async () => {
    await P.reload();
    await P.waitForSelector("#cCreate");
  };
  const check = async () => {
    await home(P);
    await P.click("#hSet");
    await P.click("#sUpd");
  };
  const banner = () => P.$(".update");

  before(async () => {
    h = await startHarness();
    P = await h.device();
    await P.waitForSelector("#cCreate");
  });
  after(() => h.close());

  it("says it's up to date when the deployed version is this one", async () => {
    assert.equal(await banner(), null);
    await check();
    await P.waitForSelector(".toast");
    assert.equal(await P.textContent(".toast"), "Lokki is up to date.");
  });

  it("offers a newer version when the app starts, and remembers a dismissal for that version", async () => {
    await deploy(newer);
    await restart();
    await P.waitForSelector(".update");
    assert.match(await P.textContent(".update"), /A new version of Lokki is available/);

    await P.click(".update .x");
    assert.equal(await banner(), null);
    await restart();
    await P.waitForTimeout(500);
    assert.equal(await banner(), null, "dismissed for this version");

    await check(); // asking shows it anyway
    await P.waitForSelector(".update");
  });

  it("a version newer than the dismissed one is offered again", async () => {
    await P.click(".update .x");
    await deploy({ ...newer, commit: "e".repeat(40) });
    await restart();
    await P.waitForSelector(".update");
  });

  it("Update loads the app again", async () => {
    await Promise.all([P.waitForEvent("load"), P.click(".update .go")]);
    await P.waitForSelector("#cCreate");
  });

  it("says so when it can't check", async () => {
    await deploy(null);
    await check();
    await P.waitForSelector(".toast");
    assert.match(await P.textContent(".toast"), /Couldn't check for updates/);
  });

  it("had no script errors", () => assert.deepEqual(h.errors, []));
});
