// UUIDv5 namespace for derived ids (migration + CSV import): uuid5(NAMESPACE_URL, "https://lokki.jocke.fi/entries")
export const NS_HEX = "ec6a9b0ac33a52ff9e7a2bb1c5454f31";

export const uuid4 = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
      );

export async function uuid5(name) {
  const nb = new TextEncoder().encode(name),
    buf = new Uint8Array(16 + nb.length);
  buf.set(NS_HEX.match(/../g).map((h) => parseInt(h, 16)));
  buf.set(nb, 16);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", buf)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
