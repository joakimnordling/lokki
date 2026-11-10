// The sync engine with in-memory devices against the real Python server: the scenarios of docs/sync-protocol.md.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { deriveKeys, encryptRow, newKeyring, rowKey, unlock, WrongPassphraseError } from "../../src/sync/crypto.js";
import { DifferentVaultError, OtherAppError, syncAll } from "../../src/sync/engine.js";
import { ServerClient, ServerError } from "../../src/sync/http.js";
import { MemoryDevice } from "../../src/sync/memory.js";
import { startServer } from "./server.js";

const SMALL = { name: "argon2id", m: 64, t: 1, p: 1 }; // fast Argon2id, for tests only
const PASS = "a long enough test passphrase";

let clock = 1_800_000_000_000;
const now = () => ++clock;
const entry = (id, v, extra = {}) => ({
  kind: "entry",
  id,
  metric: "running",
  t: "2026-11-08T07:30:00",
  v,
  n: null,
  u: now(),
  d: false,
  ...extra,
});
const metric = (id, extra = {}) => ({
  kind: "metric",
  id,
  name: id,
  type: "Fitness",
  created: "2026-01-01T08:00:00",
  u: now(),
  g: 0,
  deleted: false,
  ...extra,
});
const value = (device, id) => device.get("entry", id)?.v;

let servers = [];
let forgetful; // remembers the marks of only the latest two pushes
before(async () => {
  [forgetful, ...servers] = await Promise.all([startServer({ history: 2 }), startServer(), startServer()]);
});
after(async () => {
  await Promise.all([forgetful, ...servers].map((s) => s.stop()));
});

/** A vault: its keyring and the passphrase-derived keys every device of it ends up with. */
async function newVault() {
  const { keyring, dataKey } = await newKeyring(PASS, { now: now(), kdf: SMALL });
  return { keyring, keys: await deriveKeys(dataKey) };
}

/** A device of a vault, with its own state per server. */
function device(vault, ...links) {
  const d = new MemoryDevice();
  d.setKeyring(vault.keyring);
  d.keys = vault.keys;
  d.links = links.map(([srv, token], bit) => ({
    server: { url: srv.url, token, bit, cursor: 0 },
    http: new ServerClient(srv.url, token),
  }));
  return d;
}

/** Sync with every server of the device; the reports of the last pass, or the first error. */
async function sync(d) {
  const results = await syncAll({ device: d, keys: d.keys, links: d.links });
  const failed = results.find((r) => r.error);
  if (failed) throw failed.error;
  return results.map((r) => r.report);
}

const visible = (d) =>
  d
    .visible()
    .map((r) => JSON.stringify(r))
    .sort();

describe("two devices, one server", () => {
  it("send and receive changes, and a new device joins with the passphrase", async () => {
    const vault = await newVault();
    const { write } = await servers[0].vault();
    const a = device(vault, [servers[0], write]);
    a.put(metric("running"));
    a.put(entry("e1", 5));
    a.put(entry("e2", 7));
    const [first] = await sync(a);
    assert.equal(first.pushed, 3);
    assert.equal(first.keyring, "sent");

    // a new device: reads the keyring from the server and unlocks it with the passphrase
    const http = new ServerClient(servers[0].url, write);
    const { keyring } = await http.vault();
    const b = device({ keyring, keys: await deriveKeys(await unlock(keyring, PASS)) }, [servers[0], write]);
    await assert.rejects(unlock(keyring, "not the passphrase"), WrongPassphraseError);
    const [joined] = await sync(b);
    assert.equal(joined.applied, 3);
    assert.deepEqual(visible(b), visible(a));

    b.put(entry("e1", 6));
    await sync(b);
    await sync(a);
    assert.equal(value(a, "e1"), 6);
    assert.deepEqual((await sync(a))[0], {
      pulled: 0,
      applied: 0,
      pushed: 0,
      unknownFormat: 0,
      damaged: [],
      repaired: 0,
      keyring: "same",
    });
  });

  it("when both edit the same entry offline, the later edit wins on both", async () => {
    const vault = await newVault();
    const { write } = await servers[0].vault();
    const a = device(vault, [servers[0], write]);
    const b = device(vault, [servers[0], write]);
    a.put(metric("running"));
    a.put(entry("e1", 1));
    await sync(a);
    await sync(b);

    a.put(entry("e1", 2));
    b.put(entry("e1", 3)); // later
    a.put(entry("e2", 20));
    await sync(a);
    const [late] = await sync(b); // its push is refused (409), it pulls, merges and pushes again
    assert.ok(late.pushed >= 1);
    await sync(a);

    assert.equal(value(a, "e1"), 3);
    assert.deepEqual(visible(a), visible(b));
  });

  it("pages through many records in both directions", async () => {
    const vault = await newVault();
    const { write } = await servers[0].vault();
    const a = device(vault, [servers[0], write]);
    a.put(metric("running"));
    for (let i = 0; i < 1234; i++) a.put(entry(`e${i}`, i));
    assert.equal((await sync(a))[0].pushed, 1235); // in batches of the server's push limit
    const b = device(vault, [servers[0], write]);
    assert.equal((await sync(b))[0].applied, 1235); // in pages of its pull limit
    assert.deepEqual(visible(b), visible(a));
  });
});

describe("several servers", () => {
  it("changes travel between servers through devices that use both", async () => {
    const vault = await newVault();
    const [one, two] = await Promise.all([servers[0].vault(), servers[1].vault()]);
    const a = device(vault, [servers[0], one.write]);
    const b = device(vault, [servers[0], one.write], [servers[1], two.write]);
    const c = device(vault, [servers[1], two.write]);
    a.put(metric("running"));
    a.put(entry("e1", 1));
    await sync(a);
    await sync(b);
    await sync(c);
    assert.equal(value(c, "e1"), 1);

    c.put(entry("e1", 9));
    await sync(c);
    await sync(b);
    await sync(a);
    assert.equal(value(a, "e1"), 9);
    for (const d of [a, b, c]) assert.deepEqual(visible(d), visible(b));
  });

  it("deleting a metric stays final, even when an older edit reaches another server first", async () => {
    const vault = await newVault();
    const [one, two] = await Promise.all([servers[0].vault(), servers[1].vault()]);
    const a = device(vault, [servers[0], one.write]);
    const b = device(vault, [servers[0], one.write], [servers[1], two.write]);
    const c = device(vault, [servers[1], two.write]);
    a.put(metric("cycling"));
    a.put(entry("c1", 10, { metric: "cycling" }));
    await sync(a);
    await sync(b);
    await sync(c);

    // A deletes the metric (generation = the deletion's u) and blanks its entries
    const u = now();
    a.put(metric("cycling", { name: null, type: null, created: null, u, g: u, deleted: true }));
    a.put(entry("c1", null, { metric: "cycling", t: null, u: now(), d: true }));
    await sync(a);
    // C, which never heard of the deletion, edits the metric later and reaches only server two
    c.put(metric("cycling", { name: "Cycling!" }));
    await sync(c);
    // B merges both servers: the deletion wins and is passed on to server two
    await sync(b);
    await sync(c);
    await sync(a);
    for (const d of [a, b, c]) {
      assert.equal(d.get("metric", "cycling").deleted, true);
      assert.deepEqual(visible(d), []);
    }

    // a restore (from a backup) joins the deletion's generation and wins everywhere
    a.put(metric("cycling", { u: now(), g: u }));
    await sync(a);
    await sync(b);
    await sync(c);
    assert.equal(c.get("metric", "cycling").deleted, false);
  });
});

describe("the keyring", () => {
  it("a passphrase change travels to every server, and only the new passphrase opens it", async () => {
    const { keyring, dataKey } = await newKeyring(PASS, { now: now(), kdf: SMALL });
    const vault = { keyring, keys: await deriveKeys(dataKey) };
    const [one, two] = await Promise.all([servers[0].vault(), servers[1].vault()]);
    const a = device(vault, [servers[0], one.write]);
    const b = device(vault, [servers[0], one.write], [servers[1], two.write]);
    await sync(a);
    await sync(b);

    const { changePassphrase } = await import("../../src/sync/crypto.js");
    a.setKeyring(await changePassphrase(keyring, dataKey, "the new passphrase", { now: now(), kdf: SMALL }));
    await sync(a);
    const [fromOne, toTwo] = await sync(b);
    assert.equal(fromOne.keyring, "updated");
    assert.equal(toTwo.keyring, "sent");

    const onTwo = (await new ServerClient(servers[1].url, two.read).vault()).keyring;
    assert.deepEqual(await unlock(onTwo, "the new passphrase"), dataKey);
    await assert.rejects(unlock(onTwo, PASS), WrongPassphraseError);
  });

  it("a server's keyring changed without the keys is replaced, and another vault's is refused", async () => {
    const vault = await newVault();
    const { write } = await servers[0].vault();
    const http = new ServerClient(servers[0].url, write);
    const a = device(vault, [servers[0], write]);
    await sync(a);
    const forged = { ...vault.keyring, u: vault.keyring.u + 1000 }; // newer, but its mac no longer matches
    await http.putKeyring(1, forged);
    const [report] = await sync(a);
    assert.equal(report.keyring, "damaged");
    assert.deepEqual((await http.vault()).keyring, vault.keyring);

    const stranger = device(await newVault(), [servers[0], write]);
    await assert.rejects(sync(stranger), DifferentVaultError);
  });

  it("refuses a vault of another app, and leaves it as it was", async () => {
    const { write } = await servers[0].vault();
    const http = new ServerClient(servers[0].url, write);
    const theirs = { ...(await newVault()).keyring, app: "other-app" };
    await http.putKeyring(0, theirs);

    const lokki = device(await newVault(), [servers[0], write]);
    await assert.rejects(sync(lokki), OtherAppError);
    assert.deepEqual((await http.vault()).keyring, theirs);
    assert.equal((await http.vault()).rows, 0);
  });
});

describe("damaged, unknown and missing data", () => {
  it("repairs damaged rows from the device's copy and leaves newer formats alone", async () => {
    const vault = await newVault();
    const { write } = await servers[0].vault();
    const http = new ServerClient(servers[0].url, write);
    const a = device(vault, [servers[0], write]);
    a.put(metric("running"));
    a.put(entry("e1", 1));
    await sync(a);
    let { head, mark } = await http.pull(0);
    const damagedKey = await rowKey(vault.keys, "entry", "e1");
    const swapped = await encryptRow(vault.keys, entry("e2", 2)); // a valid row under the wrong key
    head = (
      await http.push(head, mark, [
        { key: damagedKey, data: swapped.data },
        { key: "AAAAAAAAAAAAAAAAAAAAAA", data: "v9.from-a-newer-app" },
      ])
    ).head;

    const [report] = await sync(a);
    assert.deepEqual(report.damaged, [damagedKey]);
    assert.equal(report.repaired, 1);
    assert.equal(report.unknownFormat, 1);
    const b = device(vault, [servers[0], write]);
    const [fresh] = await sync(b);
    assert.deepEqual([fresh.damaged, fresh.unknownFormat], [[], 1]);
    assert.equal(value(b, "e1"), 1);
  });

  it("starts over with a server that lost changes, or is a different server at the same address", async () => {
    const vault = await newVault();
    const [first, restored, other] = await Promise.all([servers[0].vault(), servers[0].vault(), servers[1].vault()]);
    const a = device(vault, [servers[0], first.write]);
    a.put(metric("running"));
    a.put(entry("e1", 1));
    await sync(a);
    const link = a.links[0];
    assert.equal((await sync(a))[0].pushed, 0);

    // the same server, restored from a backup taken before any of this: its head is behind our cursor
    link.http = new ServerClient(servers[0].url, restored.write);
    assert.equal((await sync(a))[0].pushed, 2);
    // a different server answering at the same address: its ID differs
    link.http = new ServerClient(servers[1].url, other.write);
    assert.equal((await sync(a))[0].pushed, 2);
    assert.equal(link.server.id, (await link.http.info()).id);
    assert.equal(link.server.cursor, (await link.http.vault()).head);
  });
});

describe("a server's history", () => {
  it("notices a server that lost changes, even after another device pushed past them", async () => {
    const vault = await newVault();
    const [before, restored] = await Promise.all([servers[0].vault(), servers[0].vault()]);
    const laptop = device(vault, [servers[0], before.write]);
    laptop.put(metric("running"));
    laptop.put(entry("e1", 1));
    await sync(laptop);
    const link = laptop.links[0];
    assert.equal(link.server.cursor, 2);

    // The same server, restored from before the laptop's push; then the phone, which hadn't seen it, pushed three
    // records. The head is past the laptop's cursor again, but rows 1 and 2 aren't what the laptop pulled.
    const phone = device(vault, [servers[0], restored.write]);
    phone.put(metric("walking"));
    phone.put(entry("w1", 5, { metric: "walking" }));
    phone.put(entry("w2", 6, { metric: "walking" }));
    await sync(phone);
    link.http = new ServerClient(servers[0].url, restored.write);
    assert.ok((await link.http.vault()).head > link.server.cursor);

    const [report] = await sync(laptop);
    assert.equal(report.pulled, 3, "everything the phone pushed");
    assert.equal(report.pushed, 2, "what the server lost");
    assert.deepEqual([value(laptop, "w1"), value(laptop, "w2")], [5, 6]);
    await sync(phone);
    assert.deepEqual(visible(phone), visible(laptop));
  });

  it("a device away for longer than the server remembers pulls everything once", async () => {
    const vault = await newVault();
    const { write } = await forgetful.vault();
    const [a, b] = [device(vault, [forgetful, write]), device(vault, [forgetful, write])];
    a.put(metric("running"));
    a.put(entry("e1", 1));
    await sync(a);
    for (let n = 2; n <= 4; n++) {
      await sync(b);
      b.put(entry(`e${n}`, n));
      await sync(b); // one push each
    }

    const [report] = await sync(a);
    assert.equal(report.pulled, 5, "every row, not only the three new ones");
    assert.equal(report.pushed, 0, "the server lost nothing");
    assert.deepEqual(visible(a), visible(b));
    b.put(entry("e5", 5));
    await sync(b);
    assert.equal((await sync(a))[0].pulled, 1, "and then only what's new again");
  });
});

describe("tokens and connections", () => {
  it("a read token receives everything but can't send", async () => {
    const vault = await newVault();
    const { write, read } = await servers[0].vault();
    const a = device(vault, [servers[0], write]);
    a.put(metric("running"));
    await sync(a);
    const reader = device(vault, [servers[0], read]);
    reader.setKeyring(null);
    await sync(reader);
    assert.equal(reader.get("metric", "running").name, "running");
    reader.put(entry("e1", 1));
    await assert.rejects(sync(reader), (e) => e instanceof ServerError && e.status === 403);
  });

  it("an unreachable server and a revoked token are errors the app can show", async () => {
    const vault = await newVault();
    const offline = device(vault, [{ url: "http://127.0.0.1:9" }, "lk_x"]);
    await assert.rejects(sync(offline), (e) => e instanceof ServerError && e.status === 0 && e.code === "unreachable");
    const revoked = device(vault, [servers[0], "lk_revoked"]);
    await assert.rejects(
      sync(revoked),
      (e) => e instanceof ServerError && e.status === 401 && e.code === "unauthorized",
    );
  });
});
