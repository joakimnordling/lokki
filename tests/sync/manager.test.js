// The shared sync manager (packages/sync/manager.js) against the real Python server: the server bits it may hand
// out, and pausing a server on one device.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { deriveKeys, newKeyring } from "../../packages/sync/crypto.js";
import { ServerClient } from "../../packages/sync/http.js";
import { createSyncManager } from "../../packages/sync/manager.js";
import { MemoryDevice } from "../../packages/sync/memory.js";
import { LOKKI } from "../../src/sync/app.js";
import { startServer } from "./server.js";

const SMALL = { name: "argon2id", m: 64, t: 1, p: 1 }; // fast Argon2id, for tests only
let clock = 1_800_000_000_000;
const entry = (id, v) => ({
  kind: "entry",
  id,
  metric: "m",
  t: "2026-11-21T08:00:00",
  v,
  n: null,
  u: ++clock,
  d: false,
});

// The device the manager wants: a MemoryDevice with the vault and persist() of an app's device
class TestDevice extends MemoryDevice {
  constructor(vault, store) {
    super({ merge: LOKKI.merge });
    this.vault = vault;
    this.store = store;
  }
  keyring() {
    return this.vault.keyring;
  }
  setKeyring(keyring) {
    this.vault.save(keyring);
  }
  async persist(ops = []) {
    await this.store.write(ops);
  }
}

let servers = [];
before(async () => {
  servers = await Promise.all([startServer(), startServer(), startServer()]);
});
after(async () => {
  for (const s of servers) await s.stop();
});

/** A manager with a vault, an in-memory store, and a count of the requests it sends to each server. */
async function manager(options = {}) {
  const rows = new Map();
  const store = {
    all: async () => [...rows.values()],
    write: async (ops) => {
      for (const [op, v] of ops) op === "put" ? rows.set(v.k, v) : rows.delete(v);
    },
  };
  const m = createSyncManager({
    app: LOKKI,
    store,
    makeDevice: (vault) => new TestDevice(vault, store),
    words: { otherApp: "another app" },
    ...options,
  });
  await m.load();
  const { keyring, dataKey } = await newKeyring("a long enough test passphrase", {
    app: LOKKI.name,
    now: ++clock,
    kdf: SMALL,
  });
  await m.saveVault(keyring, await deriveKeys(dataKey, LOKKI.name));
  m.requests = new Map();
  m.client = (url, token) => {
    const http = new ServerClient(url, token);
    return new Proxy(http, {
      get: (target, name) => {
        const f = target[name];
        if (typeof f !== "function") return f;
        return (...args) => {
          m.requests.set(url, (m.requests.get(url) || 0) + 1);
          return f.apply(target, args);
        };
      },
    });
  };
  m.rows = rows;
  return m;
}
const add = async (m, i) => {
  const { write } = await servers[i].vault();
  const s = await m.addServer(servers[i].url, write);
  clearTimeout(m.timer);
  return s;
};
const settle = async (m) => {
  clearTimeout(m.timer);
  await m.now();
  clearTimeout(m.timer);
};

describe("server bits", () => {
  it("are 0 to 30 by default, the lowest free one first", async () => {
    const m = await manager();
    assert.equal((await add(m, 0)).bit, 0);
    assert.equal((await add(m, 1)).bit, 1);
    await m.removeServer(0);
    assert.equal((await add(m, 2)).bit, 0);
    for (let b = 2; b <= 30; b++) m.servers.push({ bit: b });
    await assert.rejects(add(m, 0), /Too many servers/);
  });

  it("stay within the app's range, and say when it's full", async () => {
    const m = await manager({ bits: { from: 3, to: 4 } });
    assert.equal((await add(m, 0)).bit, 3);
    assert.equal((await add(m, 1)).bit, 4);
    await assert.rejects(add(m, 2), /Too many servers/);
  });

  it("leave a stored server outside the range working", async () => {
    const m = await manager({ bits: { from: 0, to: 0 } });
    const { write } = await servers[1].vault();
    m.servers.push({ k: "server:9", bit: 9, url: servers[1].url, token: write, name: "old", cursor: 0, mark: null });
    m.device.put(entry("e1", 1));
    await settle(m);
    assert.equal(m.servers[0].last.ok, true);
    assert.equal(m.status().onlyHere, 0, "the stored server has the change");
    assert.equal((await add(m, 0)).bit, 0);
  });

  it("must be whole numbers with 0 ≤ from ≤ to ≤ 30", async () => {
    for (const bits of [{ from: -1, to: 3 }, { from: 4, to: 3 }, { from: 0, to: 31 }, { from: 0.5, to: 3 }, {}])
      await assert.rejects(manager({ bits }), RangeError, JSON.stringify(bits));
  });
});

describe("pausing a server", () => {
  it("leaves it out of rounds, keeps its cursor and the records' bits, and syncs it when resumed", async () => {
    const m = await manager();
    const one = await add(m, 0);
    const two = await add(m, 1);
    m.device.put(entry("e1", 1));
    await settle(m);
    assert.deepEqual([one.last.ok, two.last.ok], [true, true]);

    await m.setPaused(two.bit, true);
    assert.equal(m.rows.get("server:1").paused, true, "saved");
    m.device.put(entry("e2", 2));
    const before = { requests: m.requests.get(two.url), cursor: two.cursor, last: two.last };
    await settle(m);
    assert.equal(m.requests.get(two.url), before.requests, "no requests to it");
    assert.equal(two.cursor, before.cursor);
    assert.equal(two.last, before.last);
    assert.equal(m.device.lacks(two.bit), 1, "it lacks the new change");

    const st = m.status();
    assert.deepEqual(
      st.servers.map((s) => [s.bit, s.paused]),
      [
        [0, false],
        [1, true],
      ],
    );
    assert.deepEqual([st.active, st.waiting, st.onlyHere], [1, 0, 0]);
    assert.equal(m.headerState(), null);

    await m.setPaused(two.bit, false); // syncs soon
    await waitFor(() => m.device.lacks(two.bit) === 0);
    await settle(m);
    assert.ok(m.requests.get(two.url) > before.requests);
    assert.equal(m.rows.get("server:1").paused, false);
  });

  it("counts what waits for an active server, and what's on no server at all", async () => {
    const m = await manager();
    const one = await add(m, 0);
    const two = await add(m, 1);
    m.device.put(entry("e1", 1));
    await settle(m);

    // One paused: a change waits for the other, and is on no server
    await m.setPaused(two.bit, true);
    m.device.put(entry("e2", 2));
    let st = m.status();
    assert.deepEqual([st.active, st.waiting, st.onlyHere], [1, 1, 1]);
    assert.equal(m.headerState(), "waiting");

    // Every server paused: nothing waits, the change is still only here, and the header says so
    await m.setPaused(one.bit, true);
    st = m.status();
    assert.deepEqual([st.active, st.waiting, st.onlyHere], [0, 0, 1]);
    assert.equal(m.headerState(), "paused");
    const sent = [...m.requests.values()].reduce((a, b) => a + b, 0);
    await settle(m);
    assert.equal(
      [...m.requests.values()].reduce((a, b) => a + b, 0),
      sent,
      "a round sends nothing",
    );
  });

  it("never counts a paused server as failing, and removing one works as before", async () => {
    const m = await manager();
    const one = await add(m, 0);
    const two = await add(m, 1);
    two.token = "lk_not-a-token";
    await settle(m);
    assert.equal(two.last.ok, false);
    assert.equal(m.status().failing, true);
    assert.equal(m.headerState(), "bad");
    await m.setPaused(two.bit, true);
    assert.equal(m.status().failing, false);
    assert.equal(m.headerState(), null);
    await m.removeServer(two.bit);
    assert.deepEqual(
      m.servers.map((s) => s.bit),
      [one.bit],
    );
    assert.equal(m.rows.has("server:1"), false);
  });
});

async function waitFor(ok, ms = 10000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
