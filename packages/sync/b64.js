// base64url without padding (RFC 4648 §5), for keys, nonces and ciphertexts in the sync protocol.

export function toB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text) {
  const t = text.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]*$/.test(t)) throw new Error("not base64url");
  const bin = atob(t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));
export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
