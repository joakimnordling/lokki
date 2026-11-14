/* Lokki backup: building one from this device's data, and merging one back in.
   Restore merges by id and the newest u wins; things deleted here since the backup come back only if you choose so. */
import { BACKUP_VERSION } from "../core/backup-format.js";
import { normName } from "../core/names.js";
import { hasView, setView, viewOf } from "../core/prefs.js";
import { compareMetrics } from "../sync/merge.js";
import { idb } from "./idb.js";
import { commitRecs, deleteMetricOps, nextU } from "./records.js";
import { hooks, metricAll, metrics, recs, refreshMetrics } from "./state.js";

// A metric's generation (protocol 6.2). Metrics from before generations existed have none: a deletion then counts
// as its own generation, and a live metric as generation 0.
const gen = (m) => m.g ?? (m.deleted ? m.u || 0 : 0);
const asRecord = (m) => ({ ...m, g: gen(m), deleted: !!m.deleted, u: m.u || 0 });

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
            g: gen(m),
            deleted: true,
          }
        : {
            kind: "metric",
            id,
            name: m.name,
            type: m.type || null,
            mode: viewOf(id, m).mode,
            gran: viewOf(id, m).gran,
            created: m.created || null,
            u: m.u || 0,
            g: gen(m),
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
  const differs = (l, bm) => ["name", "type", "created"].some((k) => (l[k] || null) !== (bm[k] || null));
  // Which version wins: by generation (protocol 6.2), or by u alone while the local metric predates generations.
  const wins = (bm, loc) =>
    loc.g === undefined ? (bm.u || 0) > (loc.u || 0) : compareMetrics(asRecord(bm), asRecord(loc)) > 0;
  for (const [id, bm] of b.metrics) {
    const loc = metricAll.get(id),
      bu = bm.u || 0;
    if (!loc) {
      if (!bm.deleted) p.addM.push(bm);
      continue;
    }
    if (loc.deleted) {
      if (bm.deleted) continue;
      // a restore of this deletion made elsewhere wins on its own; otherwise deleted here since: only if you ask
      if (loc.g !== undefined && gen(bm) >= gen(loc) && wins(bm, loc)) p.updM.push(bm);
      else p.bringM.push(bm);
      continue;
    }
    if (bm.deleted) {
      if (wins(bm, loc)) p.delM.push(bm);
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
    list = [];
  const putM = (id, d, bm) => {
    metricAll.set(id, { ...d, sb: 0 });
    ops.push(["metrics", "put", { id, ...d, sb: 0 }]);
    // the backup's view, only where this device has none of its own
    if (!hasView(id) && (bm.mode || bm.gran)) setView(id, viewOf(id, bm));
  };
  const mdata = (bm) => ({ name: normName(bm.name), type: bm.type || "", created: bm.created || "" });
  for (const bm of p.addM) putM(bm.id, { ...mdata(bm), u: bm.u || 0, g: gen(bm) }, bm);
  for (const bm of p.updM) putM(bm.id, { ...mdata(bm), u: bm.u, g: gen(bm) }, bm);
  for (const bm of p.delM) ops.push(...deleteMetricOps(bm.id, bm.u));
  const back = new Set();
  if (bring)
    for (const bm of p.bringM) {
      // a restore joins the deletion's generation, so it wins over that deletion everywhere (protocol 6.2)
      const gone = metricAll.get(bm.id);
      putM(bm.id, { ...mdata(bm), u: nextU(gone?.u), g: gone ? gen(gone) : 0 }, bm);
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
  for (const be of p.updE) list.push(live(be, be.u));
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
  await commitRecs(list);
  hooks.flushSoon();
  return {
    metrics: p.addM.length + p.updM.length + p.delM.length + (bring ? p.bringM.length : 0),
    entries: list.length,
  };
}
