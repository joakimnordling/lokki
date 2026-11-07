// Sync through the claude.ai artifact database (window.claude.use("db")), used when the app runs as a claude.ai artifact.

import { store } from "../core/prefs.js";
import { idb } from "../data/idb.js";
import { fail } from "../data/records.js";
import { COL, knownDocs, metricAll, outbox, rebuild, refreshMetrics, S, ui } from "../data/state.js";
import { reconcileDoc, reconcileMetric, removedDoc } from "./reconcile.js";

let flushing = false,
  flushTimer = 0,
  backoff = 0;
let render = () => {};

export function flushSoon(ms = 300) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, ms);
}
async function sent(its) {
  const ops = [];
  for (const it of its) {
    const cur = outbox.get(it.k);
    if (cur && cur.seq === it.seq) {
      outbox.delete(it.k);
      ops.push(["outbox", "delete", it.k]);
    }
  }
  await idb.write(ops);
}
export async function flush() {
  const db = S.db;
  if (!db || !S.remoteReady || flushing || !outbox.size) return;
  flushing = true;
  let failed = false;
  try {
    const items = [...outbox.values()];
    for (const it of items.filter((i) => i.kind === "m")) {
      await db.doc(`metrics/${it.id}`).set(it.p);
      await sent([it]);
    }
    const groups = new Map();
    for (const it of items.filter((i) => i.kind === "e")) {
      if (!groups.has(it.doc)) groups.set(it.doc, []);
      groups.get(it.doc).push(it);
    }
    for (const [doc, its] of groups) {
      const e = {};
      for (const it of its) e[it.id] = it.p;
      const ref = db.doc(`${COL}/${doc}`);
      if (knownDocs.has(doc)) {
        try {
          await ref.update({ e });
        } catch (err) {
          if (err && err.code === "invalid_argument") await ref.set({ m: its[0].m, y: its[0].y, e });
          else throw err;
        }
      } else await ref.set({ m: its[0].m, y: its[0].y, e });
      knownDocs.add(doc);
      await sent(its);
    }
    for (const it of items.filter((i) => i.kind === "x")) {
      await db.doc(`${COL}/${it.doc}`).delete();
      knownDocs.delete(it.doc);
      await sent([it]);
    }
    backoff = 0;
    S.syncErr = false;
  } catch (err) {
    failed = true;
    S.syncErr = true;
    backoff = Math.min(60000, (backoff || 2500) * 2);
    if (err && err.code === "quota_exceeded") fail(err);
  } finally {
    flushing = false;
  }
  if (failed) flushSoon(backoff);
  else if (outbox.size) flushSoon(50);
  if (ui.view === "list" && !document.querySelector(".scrim")) render();
}

// Connects to the claude.ai database and downloads, then keeps this device's copy in step with it.
// Returns false when there is no database (not running on claude.ai).
export async function connectClaude(renderFn) {
  render = renderFn;
  addEventListener("online", () => flushSoon(0));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) flushSoon(0);
  });
  const cl = window.claude;
  [S.db, S.dl] = cl?.use
    ? await Promise.all([cl.use("db").catch(() => null), cl.use("downloads").catch(() => null)])
    : [null, null];
  const db = S.db;
  if (!db) {
    render();
    return false;
  }
  const timer = setTimeout(() => {
    if (!S.remoteReady) {
      S.stale = true;
      render();
    }
  }, 10000);
  const ready = () => {
    if (S.gotMetrics && S.gotEntries && !S.remoteReady) {
      S.remoteReady = true;
      S.stale = false;
      clearTimeout(timer);
      flushSoon(0);
    }
  };
  let rt = 0;
  const soon = () => {
    cancelAnimationFrame(rt);
    rt = requestAnimationFrame(() => {
      rebuild();
      if (ui.view === "list" || !document.querySelector(".scrim")) render();
    });
  };
  const onErr = () => {
    S.stale = true;
    soon();
  };
  db.collection("metrics").onSnapshot((s) => {
    const ops = [];
    for (const ch of s.docChanges()) {
      if (ch.type === "removed") {
        metricAll.delete(ch.doc.id);
        ops.push(["metrics", "delete", ch.doc.id]);
      } else ops.push(...reconcileMetric(ch.doc.id, ch.doc.data() || {}));
    }
    refreshMetrics();
    idb.write(ops);
    if (!s.metadata.fromCache) S.gotMetrics = true;
    ready();
    soon();
  }, onErr);
  db.collection(COL).onSnapshot((s) => {
    const ops = [];
    for (const ch of s.docChanges()) {
      const id = ch.doc.id;
      if (ch.type === "removed") ops.push(...removedDoc(id));
      else {
        knownDocs.add(id);
        ops.push(...reconcileDoc(id, ch.doc.data() || {}));
      }
    }
    const w = idb.write(ops);
    if (!s.metadata.fromCache) {
      S.gotEntries = true;
      if (!S.fullCopy && idb.db)
        w.then(() => {
          S.fullCopy = true;
          store.set("fullCopy", true);
        });
    }
    ready();
    if (outbox.size) flushSoon();
    soon();
  }, onErr);
  return true;
}
