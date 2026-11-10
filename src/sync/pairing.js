// A server's URL and token in one text, for a QR code: `lokki-server token add … --qr` prints it, and the Sync
// screens scan it. Its own scheme, not an https link, so the iPhone's Camera app won't open it in Safari (whose
// storage a home-screen app doesn't share) and leave the token in Safari's history.
const PREFIX = "lokki:sync?";

export const pairingText = (url, token) => PREFIX + new URLSearchParams({ url, token });

/** {url, token} from a scanned text, or null if it isn't one. */
export function parsePairing(text) {
  if (typeof text !== "string" || !text.startsWith(PREFIX)) return null;
  const params = new URLSearchParams(text.slice(PREFIX.length));
  const url = params.get("url");
  const token = params.get("token");
  return url && token && /^https?:\/\/\S+$/.test(url) && /^\S+$/.test(token) ? { url, token } : null;
}
