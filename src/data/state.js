/* Local-first: every entry lives in memory and in IndexedDB on this device, and syncs through the servers set up in
   Preferences (src/sync). Entries: {id, m, y, t, v, n?, u} or a tombstone {id, m, y, u, d: true}, where t = when it
   happened (naive local time), u = when the record last changed (UTC epoch ms), d = deleted. */
import { parseLocal } from "../core/format.js";
import { sameName } from "../core/names.js";
import { hasView, setView, store, viewOf } from "../core/prefs.js";

export const metricAll = new Map(); // id -> metric doc, tombstones included
export const metrics = new Map(); // id -> live metrics only
export const recs = new Map(); // entry id -> {id,m,y,t,v,n?,u} or {id,m,y,u,d:true}

// Scalars shared between modules.
export const S = {
  localReady: false, // this device's copy has loaded
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
  for (const [id, m] of metricAll) {
    if (!m.deleted && m.name) metrics.set(id, m);
    // The chart view used to be kept on the metric; it's per device now. Keep a metric's old view on this device.
    if ((m.mode || m.gran) && !hasView(id)) setView(id, viewOf(id, m));
  }
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
