// IndexedDB: this device's copy (stores recs, metrics and outbox). Every call degrades to a no-op if IndexedDB is unavailable.
export const idb = {
  db: null,
  async open() {
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open("lokki", 2);
        r.onupgradeneeded = () => {
          const d = r.result;
          for (const [n, k] of [
            ["recs", "id"],
            ["metrics", "id"],
            ["outbox", "k"], // changes waiting for the claude.ai database
            ["sync", "k"], // standalone sync: the vault's keyring and keys, and each server's state (version 2)
          ])
            if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: k });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error("blocked"));
      });
    } catch (_e) {
      this.db = null;
    }
  },
  all(n) {
    if (!this.db) return Promise.resolve([]);
    return new Promise((res) => {
      try {
        const q = this.db.transaction(n).objectStore(n).getAll();
        q.onsuccess = () => res(q.result || []);
        q.onerror = () => res([]);
      } catch (_e) {
        res([]);
      }
    });
  },
  // ops: [store, "put"|"delete", value|key]
  write(ops) {
    if (!this.db || !ops.length) return Promise.resolve();
    return new Promise((res) => {
      try {
        const tx = this.db.transaction([...new Set(ops.map((o) => o[0]))], "readwrite");
        for (const [n, op, v] of ops) tx.objectStore(n)[op](v);
        tx.oncomplete = () => res();
        tx.onerror = tx.onabort = () => res();
      } catch (_e) {
        res();
      }
    });
  },
};
