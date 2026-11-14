// A device that keeps everything in memory: the reference adapter for the sync engine, used by tests and tools.
import { compareRecords } from "./merge.js";

const id = (kind, recordId) => `${kind}:${recordId}`;

export class MemoryDevice {
  constructor() {
    this.records = new Map(); // "kind:id" -> {record, bits, unreadable}: servers with this version / with one it can't read
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
    for (const record of records) {
      const old = this.records.get(id(record.kind, record.id));
      this.records.set(id(record.kind, record.id), {
        record,
        bits: 1 << bit,
        unreadable: (old?.unreadable ?? 0) & ~(1 << bit),
      });
    }
  }
  markHas(kind, recordId, bit) {
    const found = this.records.get(id(kind, recordId));
    if (found) {
      found.bits |= 1 << bit;
      found.unreadable &= ~(1 << bit);
    }
  }
  markLacks(kind, recordId, bit) {
    const found = this.records.get(id(kind, recordId));
    if (found) {
      found.bits &= ~(1 << bit);
      found.unreadable &= ~(1 << bit);
    }
  }
  markUnreadable(kind, recordId, bit) {
    const found = this.records.get(id(kind, recordId));
    if (found) found.unreadable |= 1 << bit;
  }
  pending(bit) {
    const out = [];
    for (const { record, bits, unreadable } of this.records.values()) {
      if ((bits | unreadable) & (1 << bit)) continue;
      if (record.kind === "entry" && !record.d && this.get("metric", record.metric)?.deleted) continue;
      out.push(record);
    }
    return out;
  }
  clearBit(bit) {
    for (const found of this.records.values()) {
      found.bits &= ~(1 << bit);
      found.unreadable &= ~(1 << bit);
    }
  }
  all() {
    return [...this.records.values()].map((r) => r.record);
  }

  /** A change made on this device: no server has it yet. Keeps the existing version if it's newer. */
  put(record) {
    const current = this.get(record.kind, record.id);
    if (current && compareRecords(current, record) > 0) return false;
    const old = this.records.get(id(record.kind, record.id));
    this.records.set(id(record.kind, record.id), { record, bits: 0, unreadable: old?.unreadable ?? 0 });
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
