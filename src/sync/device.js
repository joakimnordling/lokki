/* The app's data as a device for the sync engine (engine.js): converts between the app's records and the protocol's,
   and keeps each record's server bits (sb) in IndexedDB. Rows that servers hold in a format this device can't read (a
   newer Lokki's) are kept by row name in the sync store, "unreadable:<key>" -> {bits}, so nothing is pushed over them
   (protocol 7.5). */
import { idb } from "../data/idb.js";
import { metricAll, recs } from "../data/state.js";

/** An app entry as a protocol record (docs/sync-protocol.md, section 3). */
export const entryRecord = (r) =>
  r.d
    ? { kind: "entry", id: r.id, metric: r.m, t: null, v: null, n: null, u: r.u, d: true }
    : { kind: "entry", id: r.id, metric: r.m, t: r.t, v: r.v, n: r.n || null, u: r.u, d: false };

/** An app metric as a protocol record. Metrics from before generations count a deletion as its own generation. */
export const metricRecord = (id, m) =>
  m.deleted
    ? { kind: "metric", id, name: null, type: null, created: null, u: m.u || 0, g: m.g ?? (m.u || 0), deleted: true }
    : {
        kind: "metric",
        id,
        name: m.name,
        type: m.type || null,
        created: m.created || null,
        u: m.u || 0,
        g: m.g || 0,
        deleted: false,
      };

const toEntry = (rec, old) =>
  rec.d
    ? { id: rec.id, m: rec.metric, y: old?.y ?? (rec.t ? +rec.t.slice(0, 4) : 0), u: rec.u, d: true }
    : {
        id: rec.id,
        m: rec.metric,
        y: +rec.t.slice(0, 4),
        t: rec.t,
        v: rec.v,
        ...(rec.n ? { n: rec.n } : {}),
        u: rec.u,
      };
const toMetric = (rec) =>
  rec.deleted
    ? { deleted: true, u: rec.u, g: rec.g }
    : { name: rec.name, type: rec.type || "", created: rec.created || "", u: rec.u, g: rec.g || 0 };

export class AppDevice {
  /**
   * vault: {keyring, save(keyring)}; changed(): called after pulled records were stored; unreadable: the sync store's
   * "unreadable:<key>" rows.
   */
  constructor(vault, changed, unreadable = []) {
    this.vault = vault;
    this.changed = changed;
    this.dirty = new Set(); // "e:id" / "m:id" / "u:key" whose bits changed and must be saved
    this.unreadableRows = new Map(unreadable.map((r) => [r.k.slice("unreadable:".length), r.bits]));
  }

  keyring() {
    return this.vault.keyring;
  }
  setKeyring(keyring) {
    this.vault.save(keyring);
  }
  get(kind, id) {
    if (kind === "entry") {
      const r = recs.get(id);
      return r ? entryRecord(r) : null;
    }
    const m = metricAll.get(id);
    return m ? metricRecord(id, m) : null;
  }
  async apply(records, bit) {
    const ops = [];
    for (const rec of records) {
      if (rec.kind === "entry") {
        const r = { ...toEntry(rec, recs.get(rec.id)), sb: 1 << bit };
        recs.set(r.id, r);
        ops.push(["recs", "put", r]);
      } else {
        const m = { ...toMetric(rec), sb: 1 << bit };
        metricAll.set(rec.id, m);
        ops.push(["metrics", "put", { id: rec.id, ...m }]);
      }
    }
    await idb.write(ops);
    this.changed();
  }
  #bits(kind, id, f) {
    const target = kind === "entry" ? recs.get(id) : metricAll.get(id);
    if (!target) return;
    const before = target.sb || 0;
    target.sb = f(before);
    if (target.sb !== before) this.dirty.add(`${kind === "entry" ? "e" : "m"}:${id}`);
  }
  markHas(kind, id, bit) {
    this.#bits(kind, id, (b) => b | (1 << bit));
  }
  markLacks(kind, id, bit) {
    this.#bits(kind, id, (b) => b & ~(1 << bit));
  }
  /** Records the server lacks, metrics first; never live entries of a deleted metric. */
  pending(bit) {
    const mask = 1 << bit;
    const out = [];
    for (const [id, m] of metricAll) if (!((m.sb || 0) & mask)) out.push(metricRecord(id, m));
    for (const r of recs.values()) {
      if ((r.sb || 0) & mask) continue;
      if (!r.d && metricAll.get(r.m)?.deleted) continue;
      out.push(entryRecord(r));
    }
    return out;
  }
  /** How many records a server lacks (for status), and how many no server has. */
  lacking(bits) {
    let missing = 0;
    let nowhere = 0;
    const all = bits.reduce((a, b) => a | (1 << b), 0);
    const count = (sb, skip) => {
      if (skip) return;
      if (((sb || 0) & all) !== all) missing++;
      if (!((sb || 0) & all)) nowhere++;
    };
    for (const m of metricAll.values()) count(m.sb);
    for (const r of recs.values()) count(r.sb, !r.d && metricAll.get(r.m)?.deleted);
    return { missing, nowhere };
  }
  /** Whether some change has reached none of these servers (stops at the first one). */
  anyNowhere(bits) {
    const all = bits.reduce((a, b) => a | (1 << b), 0);
    for (const m of metricAll.values()) if (!((m.sb || 0) & all)) return true;
    for (const r of recs.values()) if (!((r.sb || 0) & all) && !(!r.d && metricAll.get(r.m)?.deleted)) return true;
    return false;
  }
  lacks(bit) {
    return this.pending(bit).length;
  }
  clearBit(bit) {
    for (const id of metricAll.keys()) this.#bits("metric", id, (b) => b & ~(1 << bit));
    for (const r of recs.values()) this.#bits("entry", r.id, (b) => b & ~(1 << bit));
    for (const key of [...this.unreadableRows.keys()]) this.clearUnreadable(key, bit);
  }
  unreadable(key) {
    return this.unreadableRows.get(key) ?? 0;
  }
  markUnreadable(key, bit) {
    const bits = this.unreadable(key) | (1 << bit);
    if (bits === this.unreadable(key)) return;
    this.unreadableRows.set(key, bits);
    this.dirty.add(`u:${key}`);
  }
  clearUnreadable(key, bit) {
    const before = this.unreadable(key);
    if (!(before & (1 << bit))) return;
    const left = before & ~(1 << bit);
    if (left) this.unreadableRows.set(key, left);
    else this.unreadableRows.delete(key);
    this.dirty.add(`u:${key}`);
  }
  /** How many rows some server holds in a format this device can't read. */
  get unreadableCount() {
    return this.unreadableRows.size;
  }
  all() {
    return [...[...metricAll].map(([id, m]) => metricRecord(id, m)), ...[...recs.values()].map(entryRecord)];
  }
  /** Save the bits changed since the last call. */
  async persist(also = []) {
    await idb.write([...this.ops(), ...also]);
  }
  /**
   * The writes that save the bits changed since the last call, to make in one transaction with the servers' state:
   * a row's unreadable bit must never be lost while the server's cursor is saved past it.
   */
  ops() {
    const ops = [];
    for (const k of this.dirty) {
      const id = k.slice(2);
      if (k[0] === "u") {
        const bits = this.unreadableRows.get(id);
        ops.push(bits ? ["sync", "put", { k: `unreadable:${id}`, bits }] : ["sync", "delete", `unreadable:${id}`]);
      } else if (k[0] === "e") {
        const r = recs.get(id);
        if (r) ops.push(["recs", "put", r]);
      } else {
        const m = metricAll.get(id);
        if (m) ops.push(["metrics", "put", { id, ...m }]);
      }
    }
    this.dirty.clear();
    return ops;
  }
}
