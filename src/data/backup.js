/* Lokki backup: building one from this device's data, and merging one back in.
   Restore merges by id and the newest u wins; things deleted here since the backup come back only if you choose so. */
import { BACKUP_VERSION } from "../core/backup-format.js";
import { normName } from "../core/names.js";
import { idb } from "./idb.js";
import { commitRecs, deleteMetricOps, nextU } from "./records.js";
import { hooks, metricAll, metrics, outbox, recs, refreshMetrics, S } from "./state.js";

export function backupText(now = new Date()) {
  const L = [
    { kind: "header", format: "lokki", version: BACKUP_VERSION, exported: now.toISOString(), app: "lokki-web" },
  ];
  const ids = [...metricAll.keys()].sort();
  for (const id of ids) {
    const m = metricAll.get(id);
    L.push(
      m.deleted
        ? {
            kind: "metric",
            id,
            name: null,
            type: null,
            mode: null,
            gran: null,
            created: null,
            u: m.u || 0,
            deleted: true,
          }
        : {
            kind: "metric",
            id,
            name: m.name,
            type: m.type || null,
            mode: m.mode || null,
            gran: m.gran || null,
            created: m.created || null,
            u: m.u || 0,
            deleted: false,
          },
    );
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  const es = [...recs.values()]
    .filter((r) => metrics.has(r.m))
    .sort(
      (a, b) =>
        order.get(a.m) - order.get(b.m) ||
        ((a.t || "~") < (b.t || "~") ? -1 : (a.t || "~") > (b.t || "~") ? 1 : a.id < b.id ? -1 : 1),
    );
  for (const r of es)
    L.push({
      kind: "entry",
      id: r.id,
      metric: r.m,
      t: r.d ? null : r.t,
      v: r.d ? null : r.v,
      n: r.d ? null : r.n || null,
      u: r.u,
      d: !!r.d,
    });
  L.push({ kind: "footer" });
  return `${L.map((o) => JSON.stringify(o)).join("\n")}\n`;
}

export function planRestore(b) {
  const p = { addM: [], updM: [], delM: [], bringM: [], addE: [], updE: [], delE: [], bringE: [] };
  const differs = (l, bm) =>
    ["name", "type", "mode", "gran", "created"].some((k) => (l[k] || null) !== (bm[k] || null));
  for (const [id, bm] of b.metrics) {
    const loc = metricAll.get(id),
      bu = bm.u || 0;
    if (!loc) {
      if (!bm.deleted) p.addM.push(bm);
      continue;
    }
    if (loc.deleted) {
      // deleted here since: only if you ask
      if (!bm.deleted) p.bringM.push(bm);
      continue;
    }
    if (bm.deleted) {
      if (bu > (loc.u || 0)) p.delM.push(bm);
      continue;
    }
    if (bu > (loc.u || 0) && differs(loc, bm)) p.updM.push(bm);
  }
  const gone = new Set(p.delM.map((m) => m.id));
  for (const be of b.entries.values()) {
    const lm = metricAll.get(be.metric),
      bm = b.metrics.get(be.metric);
    if (gone.has(be.metric) || bm?.deleted) continue;
    if (!lm && !bm) continue; // metric unknown everywhere
    if (lm?.deleted) {
      // comes back only with its metric
      if (!be.d) p.bringE.push({ be, metric: be.metric });
      continue;
    }
    const loc = recs.get(be.id);
    if (!loc) {
      if (!be.d) p.addE.push(be);
      continue;
    }
    if (loc.d && be.d) continue;
    if (loc.d) {
      // deleted here since the backup
      if (be.u > loc.u) p.updE.push(be);
      else p.bringE.push({ be });
      continue;
    }
    if (be.d) {
      if (be.u > loc.u) p.delE.push(be);
      continue;
    }
    if (be.u > loc.u && (loc.t !== be.t || loc.v !== be.v || (loc.n || "") !== (be.n || "") || loc.m !== be.metric))
      p.updE.push(be);
  }
  return p;
}

export async function applyRestore(p, bring) {
  const ops = [],
    list = [],
    extra = [];
  const putM = (id, d) => {
    metricAll.set(id, d);
    ops.push(["metrics", "put", { id, ...d }]);
    const it = { k: `m:${id}`, kind: "m", id, p: d, seq: ++S.seq };
    outbox.set(it.k, it);
    ops.push(["outbox", "put", it]);
  };
  const mdata = (bm) => ({
    name: normName(bm.name),
    type: bm.type || "",
    created: bm.created || "",
    ...(bm.mode ? { mode: bm.mode } : {}),
    ...(bm.gran ? { gran: bm.gran } : {}),
  });
  for (const bm of p.addM) putM(bm.id, { ...mdata(bm), u: bm.u || 0 });
  for (const bm of p.updM) putM(bm.id, { ...mdata(bm), u: bm.u });
  for (const bm of p.delM) ops.push(...deleteMetricOps(bm.id, bm.u));
  const back = new Set();
  if (bring)
    for (const bm of p.bringM) {
      putM(bm.id, { ...mdata(bm), u: nextU(metricAll.get(bm.id)?.u) });
      back.add(bm.id);
    }
  refreshMetrics();
  const live = (be, u) => ({
    id: be.id,
    m: be.metric,
    y: +be.t.slice(0, 4),
    t: be.t,
    v: be.v,
    ...(be.n ? { n: be.n } : {}),
    u,
  });
  for (const be of p.addE) list.push(live(be, be.u));
  for (const be of p.updE) {
    const loc = recs.get(be.id);
    if (loc && !loc.d && (loc.y !== +be.t.slice(0, 4) || loc.m !== be.metric))
      extra.push({ id: loc.id, m: loc.m, y: loc.y, u: be.u - 1, d: true }); // moved: marker in its old place
    list.push(live(be, be.u));
  }
  for (const be of p.delE) {
    const loc = recs.get(be.id);
    list.push({ id: loc.id, m: loc.m, y: loc.y, u: be.u, d: true });
  }
  if (bring)
    for (const { be, metric } of p.bringE) {
      if (metric && !back.has(metric)) continue;
      const loc = recs.get(be.id);
      list.push(live(be, nextU(loc?.u)));
    }
  await idb.write(ops);
  await commitRecs(list, extra);
  hooks.flushSoon();
  return {
    metrics: p.addM.length + p.updM.length + p.delM.length + (bring ? p.bringM.length : 0),
    entries: list.length,
  };
}
