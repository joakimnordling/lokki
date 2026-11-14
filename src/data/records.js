/* Local changes: saved on this device first, then synced. Every changed record gets sb = 0, "no server has this
   version yet", and the sync engine sends it (src/sync). */
import { uuid4 } from "../core/ids.js";
import { idb } from "./idb.js";
import { hooks, metricAll, rebuild, recs, refreshMetrics, ui } from "./state.js";

export const nextU = (prev) => Math.max(Date.now(), (prev || 0) + 1);
// Saves changed records on this device, marked as on no server yet (sb = 0), for the sync engine to send
export async function commitRecs(list) {
  const ops = [];
  for (const r of list) {
    r.sb = 0;
    recs.set(r.id, r);
    ops.push(["recs", "put", r]);
  }
  rebuild();
  hooks.render();
  await idb.write(ops);
  hooks.flushSoon();
}
export function addEntry(mid, t, v, n) {
  return commitRecs([{ id: uuid4(), m: mid, y: +t.slice(0, 4), t, v, ...(n ? { n } : {}), u: nextU() }]);
}
export function editEntry(e, t, v, n) {
  const old = recs.get(e.id);
  if (!old) return;
  return commitRecs([{ id: old.id, m: old.m, y: +t.slice(0, 4), t, v, ...(n ? { n } : {}), u: nextU(old.u) }]);
}
export function deleteEntry(e) {
  const old = recs.get(e.id);
  if (!old || old.d) return null;
  commitRecs([{ id: old.id, m: old.m, y: old.y, u: nextU(old.u), d: true }]);
  return old;
}
export function restoreEntry(old) {
  const cur = recs.get(old.id);
  commitRecs([{ ...old, u: nextU(cur?.u) }]);
}
export function fail(e) {
  hooks.toast(
    e && e.code === "quota_exceeded"
      ? "Storage is full. Delete old entries to add more."
      : "Couldn't save on this device. Try again.",
  );
}
// data keeps its generation g (editing never changes it); the chart view isn't part of a metric any more.
export async function saveMetric(id, data) {
  const prev = metricAll.get(id);
  const { id: _id, mode: _m, gran: _g, ...rest } = data;
  const d = { ...rest, u: nextU(prev?.u), sb: 0 };
  metricAll.set(id, d);
  refreshMetrics();
  rebuild();
  hooks.render();
  await idb.write([["metrics", "put", { id, ...d }]]);
  hooks.flushSoon();
}
// Deleting a metric starts a new generation (g = u), so the deletion beats edits made elsewhere before it was known.
export function deleteMetricOps(mid, u) {
  const d = { deleted: true, u, g: u, sb: 0 };
  metricAll.set(mid, d);
  // blank every entry too, so their contents leave the servers (protocol 6.3)
  const ops = [["metrics", "put", { id: mid, ...d }]];
  for (const r of [...recs.values()])
    if (r.m === mid && !r.d) {
      const t = { id: r.id, m: r.m, y: r.y, u: nextU(r.u), d: true, sb: 0 };
      recs.set(r.id, t);
      ops.push(["recs", "put", t]);
    }
  return ops;
}
export async function deleteMetric(mid) {
  const prev = metricAll.get(mid);
  const ops = deleteMetricOps(mid, nextU(prev?.u));
  refreshMetrics();
  rebuild();
  ui.view = "list";
  hooks.render();
  await idb.write(ops);
  hooks.flushSoon();
}
