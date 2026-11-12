/* The demo (?demo): made-up logs in a database of their own, made anew every time the demo opens. Sync is off, and
   the real database and settings are never opened, so nothing done here can reach your own logs. */
import { DEMO, demoData } from "../core/demo.js";
import { PREFIX } from "../core/prefs.js";
import { idb } from "./idb.js";

/** Replaces whatever the demo held with a new year of logs, ending now. */
export async function fillDemo() {
  if (!DEMO) return; // never on the real database
  forgetSettings();
  await idb.clear(["recs", "metrics", "sync"]);
  const { metrics, entries } = demoData(new Date());
  await idb.write([...metrics.map((m) => ["metrics", "put", m]), ...entries.map((e) => ["recs", "put", e])]);
}

/** Leaves the demo for the app itself, removing the demo's logs and settings. */
export async function closeDemo() {
  if (!DEMO) return;
  forgetSettings();
  await idb.clear(["recs", "metrics", "sync"]);
  location.replace(location.pathname);
}

function forgetSettings() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch (_e) {}
}
