// Local changes: saved on this device first, then queued for sync.
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
    recs.set(r.id, r);
    ops.push(["recs", "put", r], queueEntry(r));
  }
  for (const r of extra) ops.push(queueEntry(r));
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
export async function saveMetric(id, data) {
  const prev = metricAll.get(id);
  const d = { ...data, u: nextU(prev?.u) };
  delete d.id;
  metricAll.set(id, d);
  refreshMetrics();
  rebuild();
  const it = { k: `m:${id}`, kind: "m", id, p: d, seq: ++S.seq };
  outbox.set(it.k, it);
  hooks.render();
  await idb.write([
    ["metrics", "put", { id, ...d }],
    ["outbox", "put", it],
  ]);
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
export function deleteMetricOps(mid, u) {
  const d = { deleted: true, u };
  metricAll.set(mid, d);
  const drop = new Set([...knownDocs].filter((k) => k.startsWith(`${mid}~`)));
  for (const r of recs.values()) if (r.m === mid) drop.add(docOf(r));
  const ops = [["metrics", "put", { id: mid, ...d }], ...purgeMetric(mid), ...dropQueued(mid)];
  const mt = { k: `m:${mid}`, kind: "m", id: mid, p: d, seq: ++S.seq };
  outbox.set(mt.k, mt);
  ops.push(["outbox", "put", mt]);
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
