// A server's URL and token in one text, for a QR code: `lokki-server token add … --qr` prints it (with `--app` for
// apps other than Lokki), and an app's sync screens scan it. It starts with the app's name, so each app takes only
// codes for its own vaults: "lokki:sync?url=…&token=…". Its own scheme, not an https link, so a phone's camera app
// won't open it in the browser (whose storage a home-screen app doesn't share) and leave the token in its history.
import { appName } from "./crypto.js";

const prefix = (app) => `${appName(app)}:sync?`;

export const pairingText = (url, token, app) => prefix(app) + new URLSearchParams({ url, token });

/** {url, token} from a scanned text, or null if it isn't one for this app. */
export function parsePairing(text, app) {
  const start = prefix(app);
  if (typeof text !== "string" || !text.startsWith(start)) return null;
  const params = new URLSearchParams(text.slice(start.length));
  const url = params.get("url");
  const token = params.get("token");
  return url && token && /^https?:\/\/\S+$/.test(url) && /^\S+$/.test(token) ? { url, token } : null;
}
