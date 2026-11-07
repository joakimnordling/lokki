// Merging what the sync partner sends with this device's copy. Each function returns IndexedDB ops to save.
import { docOf, dropQueued, purgeMetric, queueEntry } from "../data/records.js";
import { knownDocs, metricAll, outbox, recs, S } from "../data/state.js";

export const rkey = (r) => JSON.stringify([r.u, r.d ? 1 : 0, r.t || "", r.v ?? "", r.n || ""]);
export const newer = (a, b) => (a.u !== b.u ? a.u > b.u : rkey(a) > rkey(b)); // same u on two devices: a fixed rule both sides agree on

export function reconcileDoc(docId, data) {
  const ops = [],
    e = data.e || {},
    seen = new Set();
  if (!data.m) return ops;
  const live = !metricAll.get(data.m)?.deleted; // entries of a deleted metric are kept but hidden, and never sent back
  for (const id in e) {
    const r = { id, m: data.m, y: data.y, ...e[id] };
    seen.add(id);
    const loc = recs.get(id);
    const stale = loc && loc.m !== data.m && metricAll.get(loc.m)?.deleted; // our copy belongs to a deleted metric: the server's wins
    if (!loc || stale || newer(r, loc)) {
      recs.set(id, r);
      ops.push(["recs", "put", r]);
    } else if (live && newer(loc, r) && docOf(loc) === docId && !outbox.has(`e:${docId}:${id}`))
      ops.push(queueEntry(loc)); // server copy is older: send ours again
  }
  if (live)
    for (const loc of recs.values())
      if (docOf(loc) === docId && !seen.has(loc.id) && !outbox.has(`e:${docId}:${loc.id}`)) ops.push(queueEntry(loc)); // server lost it
  // Self-healing: a year document of a deleted metric whose entries are all older than the deletion is an orphan
  // (re-created by a device that synced before hearing of the deletion), so remove it. Newer entries mean a restore: keep.
  const mt = metricAll.get(data.m);
  if (mt?.deleted && Object.values(e).every((x) => (x.u || 0) <= mt.u) && !outbox.has(`x:${docId}`)) {
    const it = { k: `x:${docId}`, kind: "x", doc: docId, seq: ++S.seq };
    outbox.set(it.k, it);
    ops.push(["outbox", "put", it]);
  }
  return ops;
}
export function removedDoc(docId) {
  const ops = [];
  knownDocs.delete(docId);
  for (const loc of [...recs.values()])
    if (docOf(loc) === docId && !outbox.has(`e:${docId}:${loc.id}`)) {
      recs.delete(loc.id);
      ops.push(["recs", "delete", loc.id]);
    }
  return ops;
}
export function reconcileMetric(id, d) {
  const ops = [],
    loc = metricAll.get(id),
    ru = d.u || 0,
    lu = loc ? loc.u || 0 : -1;
  const take = () => {
    metricAll.set(id, d);
    ops.push(["metrics", "put", { id, ...d }]);
    if (d.deleted) ops.push(...purgeMetric(id), ...dropQueued(id));
  };
  const resend = () => {
    if (!outbox.has(`m:${id}`)) {
      const it = { k: `m:${id}`, kind: "m", id, p: loc, seq: ++S.seq };
      outbox.set(it.k, it);
      ops.push(["outbox", "put", it]);
    }
  };
  if (!loc) take();
  else if (d.deleted && !loc.deleted)
    take(); // deleted elsewhere: final, even if this device edited it later while offline
  else if (loc.deleted && !d.deleted) {
    // only a newer restore brings a deleted metric back
    if (ru > lu) take();
    else resend();
  } else if (ru > lu || (ru === lu && JSON.stringify(d) > JSON.stringify(loc))) take();
  else if (lu > ru) resend();
  return ops;
}
