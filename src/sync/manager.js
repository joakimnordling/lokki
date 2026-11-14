/* Standalone sync (lokki.jocke.fi): the vault's keyring and keys, the servers, and when to sync.
   Everything is kept in IndexedDB's "sync" store: {k: "vault", keyring, keys} and {k: "server:<bit>", ...state}.
   The keys are non-extractable CryptoKeys; neither the passphrase nor the data key is ever stored. */
import { idb } from "../data/idb.js";
import { hooks, rebuild, refreshMetrics } from "../data/state.js";
import { APP, deriveKeys, newKeyring, changePassphrase as rewrap, unlock } from "./crypto.js";
import { AppDevice } from "./device.js";
import { DifferentVaultError, OtherAppError, syncAll } from "./engine.js";
import { ServerClient } from "./http.js";

const EVERY_MS = 60000;
const AFTER_CHANGE_MS = 3000;
// After a failure that may pass (offline, a server starting up from zero instances, 429, 5xx): try again this soon,
// and only show the server as failing once these tries have failed too. A server's Retry-After is honoured.
const RETRY_MS = [5000, 20000];

export const sync = {
  vault: null, // {keyring, keys}
  servers: [], // [{bit, url, token, id, cursor, mark, keyringVersion, name, last: {at, ok, error, report}}]
  running: false,
  again: false,
  timer: 0,
  device: null,
  retryDelays: RETRY_MS,
  listeners: new Set(),

  async load() {
    const rows = await idb.all("sync");
    const vault = rows.find((r) => r.k === "vault");
    this.vault = vault ? { keyring: vault.keyring, keys: vault.keys } : null;
    this.servers = rows.filter((r) => r.k.startsWith("server:")).sort((a, b) => a.bit - b.bit);
    this.device = new AppDevice(
      {
        keyring: this.vault?.keyring ?? null,
        save: (keyring) => this.saveKeyring(keyring),
      },
      () => {
        refreshMetrics();
        rebuild();
      },
      rows.filter((r) => r.k.startsWith("unreadable:")),
    );
  },

  /** Run fn after any change in sync status (for the UI). */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  notify() {
    for (const fn of this.listeners) fn();
  },

  start() {
    addEventListener("online", () => this.soon(0));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.soon(0);
    });
    setInterval(() => {
      if (!document.hidden) this.soon(0);
    }, EVERY_MS);
    this.soon(0);
  },

  // ---- the vault

  async saveVault(keyring, keys) {
    this.vault = { keyring, keys };
    this.device.vault.keyring = keyring;
    await idb.write([["sync", "put", { k: "vault", keyring, keys }]]);
  },
  async saveKeyring(keyring) {
    this.vault.keyring = keyring;
    this.device.vault.keyring = keyring;
    await idb.write([["sync", "put", { k: "vault", keyring, keys: this.vault.keys }]]);
  },
  /** A new vault with this passphrase (the first server is empty). */
  async createVault(passphrase) {
    const { keyring, dataKey } = await newKeyring(passphrase, { now: Date.now() });
    await this.saveVault(keyring, await deriveKeys(dataKey));
  },
  /** Join the vault a server holds. Throws WrongPassphraseError or DamagedKeyringError. */
  async joinVault(keyring, passphrase) {
    const dataKey = await unlock(keyring, passphrase);
    await this.saveVault(keyring, await deriveKeys(dataKey));
  },
  async changePassphrase(current, next) {
    const dataKey = await unlock(this.vault.keyring, current);
    await this.saveKeyring(await rewrap(this.vault.keyring, dataKey, next, { now: Date.now() }));
    this.soon(0);
  },

  // ---- servers

  client(url, token) {
    return new ServerClient(url, token);
  },
  /** Look at a server before adding it: {info, keyring}, or a ServerError or OtherAppError. */
  async inspect(url, token) {
    const http = this.client(url, token);
    const [info, vault] = [await http.info(), await http.vault()];
    if (vault.keyring && vault.keyring.app !== APP) throw new OtherAppError("this server's vault is for another app");
    return { info, keyring: vault.keyring };
  },
  async addServer(url, token, name) {
    const used = new Set(this.servers.map((s) => s.bit));
    let bit = 0;
    while (used.has(bit)) bit++;
    // Each server is one bit in every record's server bits (sb). JavaScript's bitwise operators work on 32-bit
    // signed integers, so bits 0 to 30 keep sb a positive, exact number; 1 << 31 is negative and 1 << 32 is 1.
    if (bit > 30) throw new Error("Too many servers.");
    const server = {
      k: `server:${bit}`,
      bit,
      url: url.replace(/\/+$/, ""),
      token,
      name: name || hostOf(url),
      cursor: 0,
      mark: null,
      keyringVersion: 0,
      last: null,
    };
    this.device.clearBit(bit);
    await this.device.persist();
    this.servers.push(server);
    await this.saveServer(server);
    this.soon(0);
    return server;
  },
  async updateServer(bit, changes) {
    const server = this.servers.find((s) => s.bit === bit);
    Object.assign(server, changes);
    await this.saveServer(server);
    this.soon(0);
  },
  async removeServer(bit) {
    this.servers = this.servers.filter((s) => s.bit !== bit);
    this.device.clearBit(bit);
    await this.device.persist();
    await idb.write([["sync", "delete", `server:${bit}`]]);
    this.notify();
  },
  /** Delete the vault on a server (DELETE /v1/vault), then stop using it. */
  async deleteOnServer(bit) {
    const server = this.servers.find((s) => s.bit === bit);
    await this.client(server.url, server.token).deleteVault();
    await this.removeServer(bit);
  },
  async saveServer(server) {
    await idb.write([["sync", "put", { ...server }]]);
    this.notify();
  },

  // ---- syncing

  /** Sync after `ms` (coalescing requests); does nothing until a vault and a server exist. */
  soon(ms = AFTER_CHANGE_MS) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.now(), ms);
  },
  async now() {
    if (!this.vault || !this.servers.length) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.notify();
    try {
      const links = this.servers.map((server) => ({ server, http: this.client(server.url, server.token) }));
      const results = await syncAll({ device: this.device, keys: this.vault.keys, links });
      let retry = null;
      for (const { server, report, error } of results) {
        if (error?.passing && (server.tries || 0) < this.retryDelays.length) {
          // keep the last result showing for now, and try again soon
          const wait = Math.max(this.retryDelays[server.tries || 0], Math.min(error.retryAfter || 0, 120) * 1000);
          server.tries = (server.tries || 0) + 1;
          retry = retry === null ? wait : Math.min(retry, wait);
          continue;
        }
        server.tries = 0;
        server.last = {
          at: Date.now(),
          ok: !error,
          error: error ? describe(error) : null,
          report: report ? summary(report) : null,
        };
      }
      if (retry !== null) this.soon(retry);
      // The records' bits and the rows this device can't read are saved with the servers' cursors, in one transaction
      await this.device.persist(this.servers.map((s) => ["sync", "put", { ...s }]));
      hooks.render();
    } finally {
      this.running = false;
      this.notify();
      if (this.again) {
        this.again = false;
        this.soon(0);
      }
    }
  },

  /** For the top bar, cheaply: "bad" when a server failed, "waiting" when a change reached no server yet. */
  headerState() {
    if (!this.vault || !this.servers.length) return null;
    if (this.servers.some((s) => s.last && !s.last.ok)) return "bad";
    return this.device.anyNowhere(this.servers.map((s) => s.bit)) ? "waiting" : null;
  },
  /** Status for the UI: per server, and overall ("unsynced" when a change hasn't reached any server). */
  status() {
    const counts = this.servers.length ? this.device.lacking(this.servers.map((s) => s.bit)) : { nowhere: 0 };
    const servers = this.servers.map((s) => ({ ...s, lacks: this.device.lacks(s.bit) }));
    const failing = servers.some((s) => s.last && !s.last.ok);
    return {
      setUp: !!this.vault,
      running: this.running,
      servers,
      unsynced: this.servers.length ? counts.nowhere : 0,
      failing,
    };
  },
};

export const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const OTHER_APP = "This server's vault is for another app, not Lokki. Use another token or server.";

function describe(error) {
  if (error instanceof DifferentVaultError) return "This server holds a different vault.";
  if (error instanceof OtherAppError) return OTHER_APP;
  if (error.status === 0) return "Can't reach the server.";
  if (error.status === 401) return "The server doesn't accept this token any more.";
  if (error.status === 403) return "This token can only read.";
  return error.message || "Something went wrong.";
}
const summary = (r) => ({
  pulled: r.pulled,
  applied: r.applied,
  pushed: r.pushed,
  unknownFormat: r.unknownFormat,
  held: r.held,
  damaged: r.damaged.length,
  repaired: r.repaired,
});
