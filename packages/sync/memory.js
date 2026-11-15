// A device that keeps everything in memory: the reference adapter for the sync engine, used by tests and tools.
// `merge(remote, local)` is the app's rule for two versions of a record (as in the engine's app settings), and
// `held(record, get)` says which records it keeps back from servers for now (Lokki: live entries of a deleted metric).
import { sameRecord } from "./crypto.js";

const id = (kind, recordId) => `${kind}:${recordId}`;

export class MemoryDevice {
  constructor({ merge, held = () => false }) {
    this.merge = merge;
    this.held = held;
    this.records = new Map(); // "kind:id" -> {record, bits}
    this.unreadableRows = new Map(); // row name -> bits of servers holding it in a format this device can't read
    this.ring = null;
  }

  keyring() {
    return this.ring;
  }
  setKeyring(keyring) {
    this.ring = keyring;
  }
  get(kind, recordId) {
    return this.records.get(id(kind, recordId))?.record ?? null;
  }
  async apply(records, bit) {
    for (const record of records)
      this.records.set(id(record.kind, record.id), { record, bits: bit == null ? 0 : 1 << bit });
  }
  markHas(kind, recordId, bit) {
    const found = this.records.get(id(kind, recordId));
    if (found) found.bits |= 1 << bit;
  }
  markLacks(kind, recordId, bit) {
    const found = this.records.get(id(kind, recordId));
    if (found) found.bits &= ~(1 << bit);
  }
  pending(bit) {
    const out = [];
    for (const { record, bits } of this.records.values()) {
      if (bits & (1 << bit)) continue;
      if (this.held(record, (kind, recordId) => this.get(kind, recordId))) continue;
      out.push(record);
    }
    return out;
  }
  clearBit(bit) {
    for (const found of this.records.values()) found.bits &= ~(1 << bit);
    for (const key of [...this.unreadableRows.keys()]) this.clearUnreadable(key, bit);
  }
  unreadable(key) {
    return this.unreadableRows.get(key) ?? 0;
  }
  markUnreadable(key, bit) {
    this.unreadableRows.set(key, this.unreadable(key) | (1 << bit));
  }
  clearUnreadable(key, bit) {
    const left = this.unreadable(key) & ~(1 << bit);
    if (left) this.unreadableRows.set(key, left);
    else this.unreadableRows.delete(key);
  }
  all() {
    return [...this.records.values()].map((r) => r.record);
  }

  /** A change made on this device, merged with the version it has: no server has the result yet. */
  put(record) {
    const current = this.get(record.kind, record.id);
    const result = current ? this.merge(record, current) : record;
    if (sameRecord(result, current)) return false; // nothing new: it keeps its server bits
    this.records.set(id(record.kind, record.id), { record: result, bits: 0 });
    return true;
  }

  /** Live records, without deleted ones and without entries of deleted metrics: what the app would show. */
  visible() {
    const deleted = new Set(
      this.all()
        .filter((r) => r.kind === "metric" && r.deleted)
        .map((r) => r.id),
    );
    return this.all().filter((r) => (r.kind === "metric" ? !r.deleted : !r.d && !deleted.has(r.metric)));
  }
}
