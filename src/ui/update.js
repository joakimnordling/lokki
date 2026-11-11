// Noticing a newer version of the standalone app: each build publishes version.json (scripts/build-site.js), and the
// app compares its commit with its own. A home-screen app on iOS can stay paused for days without reloading, so it
// checks on start and when it comes back to the front, at most every 15 minutes, and offers a banner to update.

import { store } from "../core/prefs.js";
import { BUILD } from "../core/version.js";
import { toast } from "./sheets.js";

const EVERY_MS = 15 * 60 * 1000;
let lastCheck = 0;

/** Whether this app can check: the site's build, not unbundled development. */
const canCheck = () => !!BUILD.commit && location.protocol.startsWith("http");

/** The deployed build's info, or null when it can't be fetched. */
async function deployed() {
  try {
    const res = await fetch(new URL("version.json", document.baseURI), { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Check for a newer version. `asked`: from Preferences, so check now, show the banner even if dismissed before, and
 * say so when there's nothing new. Returns "new", "same" or "unknown".
 */
export async function checkForUpdate({ asked = false } = {}) {
  if (!canCheck()) return "unknown";
  const now = Date.now();
  if (!asked && now - lastCheck < EVERY_MS) return "unknown";
  lastCheck = now;
  const info = await deployed();
  if (!info?.commit) {
    if (asked) toast("Couldn't check for updates. Are you online?");
    return "unknown";
  }
  if (info.commit === BUILD.commit) {
    if (asked) toast("Lokki is up to date.");
    return "same";
  }
  if (asked || store.get("updateDismissed") !== info.commit) banner(info);
  return "new";
}

/** Get the new version: let the service worker fetch it, then load the page anew. */
export async function update() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch (_e) {}
  location.reload();
}

function banner(info) {
  document.querySelector(".update")?.remove();
  const b = document.createElement("div");
  b.className = "update";
  b.setAttribute("role", "status");
  b.innerHTML = `<span>A new version of Lokki is available.</span><button class="go">Update</button><button class="x" aria-label="Dismiss">✕</button>`;
  b.querySelector(".go").onclick = update;
  b.querySelector(".x").onclick = () => {
    store.set("updateDismissed", info.commit); // until a newer one comes out
    b.remove();
  };
  document.body.appendChild(b);
}

/** Check now, and whenever the app comes back to the front. */
export function watchForUpdates() {
  if (!canCheck()) return;
  checkForUpdate();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdate();
  });
}
