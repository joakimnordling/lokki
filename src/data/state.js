/* Local-first: every entry lives in memory and in IndexedDB on this device. The sync partner keeps:
     metrics/<id>               {name,type,created,mode?,gran?,u?} or a tombstone {deleted:true,u}
     entries-v2/<metric>~<year> {m, y, e:{ <entry id>: {t,v,n,u,d} }}  (deleted: t,v,n = null, d = true)
   t = when it happened (naive local time), u = when the record last changed (UTC epoch ms), d = deleted.
   Changes are queued in an outbox (also in IndexedDB) and sent as merging updates, one entry per key;
   on conflicts the record with the newest u wins. */
import { parseLocal } from "../core/format.js";
import { sameName } from "../core/names.js";
import { store } from "../core/prefs.js";

export const COL = "entries-v2";
export const metricAll = new Map(); // id -> metric doc, tombstones included
export const metrics = new Map(); // id -> live metrics only
export const recs = new Map(); // entry id -> {id,m,y,t,v,n?,u} or {id,m,y,u,d:true}
export const outbox = new Map(); // key -> queued change {k,kind,...,seq}
export const knownDocs = new Set(); // year documents that exist on the server

// Scalars shared between modules.
export const S = {
  // Standalone: not running inside claude.ai, so there is no sync partner yet; everything stays on this device.
  // Decided at start-up, once this device's copy is loaded (claude.ai provides window.claude by then).
  local: false,
  db: null, // sync database (claude.ai), null when not available
  dl: null, // downloads (claude.ai), null when not available
  fullCopy: store.get("fullCopy") === true, // this device has finished saving a complete copy at least once
  localReady: false,
  remoteReady: false,
  gotMetrics: false,
  gotEntries: false,
  stale: false,
  syncErr: false,
  seq: 0,
  entryCache: new Map(), // mid -> sorted live entries [{id,s,t,v,n,y}]
};
export const ui = {
  view: "list",
  mid: null,
  mode: store.get("mode") || "totals",
  gran: store.get("gran") || "monthly",
  sel: null,
  corr: "pos",
  rank: "high",
  filter: store.get("filter") || "",
};
// Set by app.js, so the data layer can ask for a redraw, a sync or a message without importing the UI.
export const hooks = { render() {}, flushSoon() {}, toast() {} };

export function refreshMetrics() {
  metrics.clear();
  for (const [id, m] of metricAll) if (!m.deleted && m.name) metrics.set(id, m);
}
export function rebuild() {
  const cache = new Map();
  for (const r of recs.values()) {
    if (r.d || !metrics.has(r.m)) continue;
    const a = cache.get(r.m) || [];
    a.push({ id: r.id, s: r.t, t: +parseLocal(r.t), v: +r.v, n: r.n || "", y: r.y });
    cache.set(r.m, a);
  }
  for (const a of cache.values()) a.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  S.entryCache = cache;
}
export const entriesOf = (mid) => S.entryCache.get(mid) || [];
export const findMetricByName = (name) => [...metrics.entries()].find(([, m]) => sameName(m.name, name))?.[0];
