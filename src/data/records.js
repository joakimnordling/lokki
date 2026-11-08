/* Local changes: saved on this device first, then synced.
   Standalone (lokki.jocke.fi): every changed record gets sb = 0, "no server has this version yet", and the sync
   engine sends it (src/sync). Inside claude.ai: changes are queued in the outbox for the claude.ai database. */
import { uuid4 } from "../core/ids.js";
import { idb } from "./idb.js";
import { hooks, knownDocs, metricAll, outbox, rebuild, recs, refreshMetrics, S, ui } from "./state.js";

export const nextU = (prev) => Math.max(Date.now(), (prev || 0) + 1);
export const docOf = (r) => `${r.m}~${r.y}`;
// Every field is always sent: the server merges nested objects field by field, so a cleared field must be written as null
// (otherwise a deletion would keep the old value and note, and an undo would keep d:true).
export const payload = (r) =>
  r.d ? { t: null, v: null, n: null, u: r.u, d: true } : { t: r.t, v: r.v, n: r.n || null, u: r.u, d: false };
export function queueEntry(r) {
  if (S.local) return null;
  const it = {
    k: `e:${docOf(r)}:${r.id}`,
    kind: "e",
    doc: docOf(r),
    m: r.m,
    y: r.y,
    id: r.id,
    p: payload(r),
    seq: ++S.seq,
  };
  outbox.set(it.k, it);
  return ["outbox", "put", it];
}
// list: records kept on this device; extra: send-only (the old-year tombstone of a moved entry)
export async function commitRecs(list, extra = []) {
  const ops = [];
  for (const r of list) {
    r.sb = 0;
    recs.set(r.id, r);
    ops.push(["recs", "put", r], queueEntry(r));
  }
  for (const r of extra) ops.push(queueEntry(r)); // year documents exist only in the claude.ai database
  rebuild();
  hooks.render();
  await idb.write(ops.filter(Boolean));
  hooks.flushSoon();
}
export function addEntry(mid, t, v, n) {
  return commitRecs([{ id: uuid4(), m: mid, y: +t.slice(0, 4), t, v, ...(n ? { n } : {}), u: nextU() }]);
}
export function editEntry(e, t, v, n) {
  const old = recs.get(e.id);
  if (!old) return;
  const y = +t.slice(0, 4);
  let u = nextU(old.u);
  const extra = [];
  if (y !== old.y) {
    // moved to another year: tombstone there, live copy (newer) here
    extra.push({ id: old.id, m: old.m, y: old.y, u, d: true });
    u++;
  }
  return commitRecs([{ id: old.id, m: old.m, y, t, v, ...(n ? { n } : {}), u }], extra);
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
      : "Couldn't save. Check your connection and try again.",
  );
}
// The metric as sent to the claude.ai database: without what only this device keeps.
const shared = ({ sb: _, mode: _m, gran: _g, ...rest }) => rest;
export function queueMetric(id, d) {
  if (S.local) return [];
  const it = { k: `m:${id}`, kind: "m", id, p: shared(d), seq: ++S.seq };
  outbox.set(it.k, it);
  return [["outbox", "put", it]];
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
  await idb.write([["metrics", "put", { id, ...d }], ...queueMetric(id, d)]);
  hooks.flushSoon();
}
export function purgeMetric(mid) {
  const ops = [];
  for (const r of [...recs.values()])
    if (r.m === mid) {
      recs.delete(r.id);
      ops.push(["recs", "delete", r.id]);
    }
  return ops;
}
export function dropQueued(mid) {
  const ops = [];
  for (const [k, it] of [...outbox])
    if ((it.kind === "e" && it.m === mid) || (it.kind === "m" && it.id === mid)) {
      outbox.delete(k);
      ops.push(["outbox", "delete", k]);
    }
  return ops;
}
// Deleting a metric starts a new generation (g = u), so the deletion beats edits made elsewhere before it was known.
export function deleteMetricOps(mid, u) {
  const d = { deleted: true, u, g: u, sb: 0 };
  metricAll.set(mid, d);
  if (S.local) {
    // standalone: blank every entry too, so their contents leave the servers (protocol 6.3)
    const ops = [["metrics", "put", { id: mid, ...d }]];
    for (const r of [...recs.values()])
      if (r.m === mid && !r.d) {
        const t = { id: r.id, m: r.m, y: r.y, u: nextU(r.u), d: true, sb: 0 };
        recs.set(r.id, t);
        ops.push(["recs", "put", t]);
      }
    return ops;
  }
  const drop = new Set([...knownDocs].filter((k) => k.startsWith(`${mid}~`)));
  for (const r of recs.values()) if (r.m === mid) drop.add(docOf(r));
  const ops = [["metrics", "put", { id: mid, ...d }], ...purgeMetric(mid), ...dropQueued(mid), ...queueMetric(mid, d)];
  for (const doc of drop) {
    const it = { k: `x:${doc}`, kind: "x", doc, seq: ++S.seq };
    outbox.set(it.k, it);
    ops.push(["outbox", "put", it]);
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
