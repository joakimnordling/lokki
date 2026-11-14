/* Lokki's sync (lokki.jocke.fi): the shared manager (packages/sync/manager.js) with Lokki's settings, its records
   (device.js) and IndexedDB's "sync" store. */
import { createSyncManager } from "../../packages/sync/manager.js";
import { idb } from "../data/idb.js";
import { hooks, rebuild, refreshMetrics } from "../data/state.js";
import { LOKKI } from "./app.js";
import { AppDevice } from "./device.js";

export { hostOf } from "../../packages/sync/manager.js";

export const OTHER_APP = "This server's vault is for another app, not Lokki. Use another token or server.";

export const sync = createSyncManager({
  app: LOKKI,
  store: {
    all: () => idb.all("sync"),
    write: (ops) => idb.write(ops.map(([op, value]) => ["sync", op, value])),
  },
  makeDevice: (vault, unreadable) =>
    new AppDevice(
      vault,
      () => {
        refreshMetrics();
        rebuild();
      },
      unreadable,
    ),
  words: { otherApp: OTHER_APP },
  onSynced: () => hooks.render(),
});
