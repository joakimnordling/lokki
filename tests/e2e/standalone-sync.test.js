// The standalone site syncing through the real Python server (servers/python), driven through the app's own screens.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ServerClient } from "../../src/sync/http.js";
import { startServer } from "../sync/server.js";
import { home, startHarness, toastText } from "./harness.js";

const PASS = "correct horse battery staple";

describe("standalone sync", () => {
  let h, srv, tokens, A, B;
  const open = async (pg) => {
    await home(pg);
    await pg.click("#hSet");
    await pg.click("#sSync");
  };
  const connect = async (pg, url = srv.url, token = tokens.write) => {
    await open(pg);
    await pg.fill("#sUrl", url);
    await pg.fill("#sToken", token);
    await pg.click("#sDone");
  };
  const synced = (pg) =>
    pg.waitForFunction(
      () => {
        const s = window.__lokki.sync;
        return !s.running && s.servers.length && s.servers.every((x) => x.last?.ok) && !s.headerState();
      },
      null,
      { timeout: 30000 },
    );
  const syncNow = async (pg) => {
    await pg.evaluate(() => window.__lokki.sync.now());
    await synced(pg);
  };
  const live = (pg, metric) =>
    pg.evaluate(
      (m) =>
        [...window.__lokki.recs.values()]
          .filter((r) => r.m === m && !r.d)
          .map((r) => r.v)
          .sort(),
      metric,
    );

  before(async () => {
    h = await startHarness();
    srv = await startServer({ cors: [h.base] });
    tokens = await srv.vault();
    A = await h.device("/site/", { claude: false });
    B = await h.device("/site/", { claude: false });
  });
  after(async () => {
    await srv?.stop();
    await h?.close();
  });

  it("is off until set up, with the reminder to back up", async () => {
    await A.click("#cCreate");
    await A.fill("#mName", "Running");
    await A.click("#sDone");
    for (const v of [5, 7]) {
      await A.click("[data-add]");
      await A.fill("#eVal", String(v));
      await A.click("#sDone");
    }
    assert.match(await A.textContent("#main"), /Saved on this device only/);
    await A.click("#hSet");
    assert.match(await A.textContent("#sSync"), /Off\./);
  });

  it("refuses a server whose vault is for another app, before asking for a passphrase", async () => {
    const other = await srv.vault();
    const theirs = { format: "lokki-keyring", version: 1, app: "other-app", vault: "x", keys: [{}], u: 1, mac: "x" };
    await new ServerClient(srv.url, other.write).putKeyring(0, theirs);

    await connect(A, srv.url, other.write);
    await A.waitForFunction(() => document.querySelector(".sheet .err")?.textContent);
    assert.match(await A.textContent(".sheet .err"), /for another app, not Lokki/);
    assert.equal(await A.$("#p1"), null);
    await A.click("#sCancel");
    assert.equal(await A.evaluate(() => window.__lokki.sync.vault), null);
  });

  it("turns on with a first server and a new passphrase, and sends everything encrypted", async () => {
    await connect(A);
    await A.waitForSelector("#p1");
    await A.fill("#p1", "short");
    assert.match(await A.textContent("#pStrength"), /Too short/);
    await A.fill("#p1", PASS);
    await A.fill("#p2", `${PASS}!`);
    await A.click("#sDone");
    assert.match(await A.textContent(".sheet .err"), /differ/);
    await A.fill("#p2", PASS);
    await A.click("#sDone");
    await toastText(A, /Sync is on/);
    await synced(A);
    assert.doesNotMatch(await A.textContent("#main"), /Saved on this device only/);

    const vault = await new ServerClient(srv.url, tokens.read).vault();
    assert.equal(vault.rows, 3);
    assert.equal(vault.keyring.format, "lokki-keyring");
    assert.equal(vault.keyring.app, "lokki");
    const { rows } = await new ServerClient(srv.url, tokens.read).pull(0);
    assert.ok(rows.every((r) => r.data.startsWith("v1.") && !r.data.includes("Running")));
  });

  it("another device joins with the passphrase and gets everything", async () => {
    await connect(B);
    await B.waitForSelector("#p1");
    assert.match(await B.textContent(".sheet"), /already holds your logs/);
    await B.fill("#p1", "not the passphrase at all");
    await B.click("#sDone");
    await B.waitForFunction(() => /not the passphrase/.test(document.querySelector(".sheet .err").textContent));
    await B.fill("#p1", PASS);
    await B.click("#sDone");
    await synced(B);
    assert.deepEqual(await live(B, await A.evaluate(() => [...window.__lokki.metricAll.keys()][0])), [5, 7]);
    await home(B);
    assert.match(await B.textContent("#main"), /Running/);
  });

  it("changes travel both ways", async () => {
    const mid = await A.evaluate(() => [...window.__lokki.metricAll.keys()][0]);
    await B.evaluate((m) => window.__test.add(m, "2026-11-08T08:00:00", 9, "from B"), mid);
    await synced(B); // a sync follows a change by itself
    await syncNow(A);
    assert.deepEqual(await live(A, mid), [5, 7, 9]);
  });

  it("shows when changes haven't reached a server, and when a server fails", async () => {
    const mid = await A.evaluate(() => [...window.__lokki.metricAll.keys()][0]);
    await A.context().setOffline(true);
    await A.evaluate((m) => window.__test.add(m, "2026-11-08T09:00:00", 11, ""), mid);
    await home(A);
    assert.equal(await A.getAttribute("#hSet", "aria-label"), "Preferences (changes waiting to sync)");
    await A.evaluate(() => window.__lokki.sync.now());
    await home(A);
    assert.equal(await A.getAttribute("#hSet", "aria-label"), "Preferences (sync has a problem)");
    await open(A);
    assert.match(await A.textContent("#syncBody"), /Can't reach the server/);
    await A.context().setOffline(false);
    await syncNow(A);
    await home(A);
    assert.equal(await A.getAttribute("#hSet", "aria-label"), "Preferences");
    assert.equal(await A.$(".hbtn .dot"), null);
  });

  it("says so when a server's token now opens another vault, or another app's", async () => {
    // Switch the server's token, then wait for a sync with it to report this error (or none)
    const useToken = async (token, expected) => {
      await A.evaluate(
        (t) => window.__lokki.sync.updateServer(window.__lokki.sync.servers[0].bit, { token: t }),
        token,
      );
      await A.waitForFunction(
        (e) => {
          const last = window.__lokki.sync.servers[0].last;
          return !window.__lokki.sync.running && (e === null ? last?.ok : last?.error?.startsWith(e));
        },
        expected,
        { timeout: 30000 },
      );
    };
    const keyring = (app) => ({ format: "lokki-keyring", version: 1, app, vault: "y", keys: [{}], u: 1, mac: "x" });
    const someoneElse = await srv.vault();
    await new ServerClient(srv.url, someoneElse.write).putKeyring(0, keyring("lokki"));
    const otherApp = await srv.vault();
    await new ServerClient(srv.url, otherApp.write).putKeyring(0, keyring("other-app"));

    await useToken(someoneElse.write, "This server holds a different vault.");
    await useToken(otherApp.write, "This server's vault is for another app, not Lokki.");
    await useToken(tokens.write, null);
  });

  it("keeps the chart view per device", async () => {
    await home(A);
    await A.click("text=Running");
    await A.click('[data-gran="daily"]');
    await syncNow(A);
    await syncNow(B);
    await home(B);
    await B.click("text=Running");
    assert.equal(await B.getAttribute('[data-gran="daily"]', "aria-pressed"), "false");
  });

  it("changing the passphrase keeps other devices working, and new ones need the new one", async () => {
    await open(A);
    await A.click("#yPass");
    await A.fill("#p0", PASS);
    await A.fill("#p1", "a brand new passphrase");
    await A.fill("#p2", "a brand new passphrase");
    await A.click("#sDone");
    await toastText(A, /Passphrase changed/);
    await syncNow(A);
    await syncNow(B);

    const C = await h.device("/site/", { claude: false });
    await connect(C);
    await C.waitForSelector("#p1");
    await C.fill("#p1", PASS);
    await C.click("#sDone");
    await C.waitForFunction(() => /not the passphrase/.test(document.querySelector(".sheet .err").textContent));
    await C.fill("#p1", "a brand new passphrase");
    await C.click("#sDone");
    await synced(C);
    await home(C);
    assert.match(await C.textContent("#main"), /Running/);
  });

  it("Clear Data warns about changes that reached no server, and can download everything again", async () => {
    const mid = await B.evaluate(() => [...window.__lokki.metricAll.keys()][0]);
    await syncNow(B);
    const before = await live(B, mid);
    await B.context().setOffline(true);
    await B.evaluate((m) => window.__test.add(m, "2026-11-08T10:00:00", 13, ""), mid);
    await home(B);
    await B.click("#hSet");
    await B.click("#sClr");
    assert.match(await B.textContent(".sheet"), /1 change hasn't reached any server yet/);
    await B.click("#sCancel");
    await B.context().setOffline(false);
    await syncNow(B);
    await home(B);
    await B.click("#hSet");
    await B.click("#sClr");
    assert.doesNotMatch(await B.textContent(".sheet"), /reached any server/);
    await B.click("#cCopy");
    await Promise.all([B.waitForEvent("load"), B.click("#cYes")]);
    await B.waitForFunction(() => window.__lokki?.sync?.vault);
    await synced(B);
    assert.deepEqual(await live(B, mid), [...before, 13].sort());
  });

  it("deleting a metric reaches other devices and blanks its entries on the server", async () => {
    await home(A);
    await A.click("text=Running");
    await A.click("#tbDelete");
    await A.click("#dYes");
    await syncNow(A);
    await syncNow(B);
    await home(B);
    assert.match(await B.textContent("#main"), /No metrics yet/);
    const { rows } = await new ServerClient(srv.url, tokens.read).pull(0);
    assert.ok(
      rows.every((r) => r.data.length <= 400),
      "every row is padded to the minimum size: no notes left",
    );
  });

  it("a server can be renamed by URL, removed, or emptied", async () => {
    await open(A);
    await A.click('[data-server="0"]');
    await A.fill("#sUrl", srv.url.replace("127.0.0.1", "localhost"));
    await A.click("#sDone");
    await A.waitForSelector("#syncBody");
    await syncNow(A); // the same server under another name: continues where it left off
    assert.equal(
      await A.evaluate(() => window.__lokki.sync.servers[0].name),
      new URL(srv.url.replace("127.0.0.1", "localhost")).host,
    );

    await open(B);
    await B.click('[data-server="0"]');
    await B.click("#sDelete");
    await B.click("#dYes");
    await toastText(B, /Deleted on the server/);
    await A.evaluate(() => window.__lokki.sync.now());
    await A.waitForFunction(() => /doesn't accept this token/.test(window.__lokki.sync.servers[0].last?.error || ""));
    await open(A);
    await A.click('[data-server="0"]');
    await A.click("#sRemove");
    await toastText(A, /Server removed/);
    assert.equal(await A.evaluate(() => window.__lokki.sync.servers.length), 0);
  });

  it("had no script errors", () => assert.deepEqual(h.errors, []));
});
