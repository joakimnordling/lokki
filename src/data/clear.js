/* Clearing this device's data. Both ways reload the app afterwards, so nothing in memory outlives what was cleared.
   - clearEverything: the logs, the sync setup and this device's settings. What's on the servers stays.
   - clearCopy: only the logs; they download again from the servers, and the settings and the sync setup stay.
     Changes that haven't reached a server yet are lost, so the UI warns first. */
import { idb } from "./idb.js";

const reload = () => location.reload();

export async function clearEverything() {
  await idb.destroy();
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("lokki:")) localStorage.removeItem(k);
  } catch (_e) {}
  reload();
}

/** servers: the standalone sync's servers, whose state is reset so the next sync downloads everything. */
export async function clearCopy(servers = []) {
  await idb.clear(["recs", "metrics"]);
  await idb.write(servers.map((s) => ["sync", "put", { ...s, cursor: 0, mark: null, keyringVersion: 0, last: null }]));
  reload();
}
