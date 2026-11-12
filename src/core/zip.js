export const pipeBytes = async (data, stream) =>
  new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const put = (view, fields) => {
  for (const [o, v, n] of fields) n === 4 ? view.setUint32(o, v, true) : view.setUint16(o, v, true);
};
// A standard single-file .zip (deflate), readable by Files on iPhone, Finder, unzip, Python's zipfile...
export async function zipOne(name, bytes, d = new Date()) {
  const nm = new TextEncoder().encode(name),
    crc = crc32(bytes);
  let data = bytes,
    method = 0;
  try {
    data = await pipeBytes(bytes, new CompressionStream("deflate-raw"));
    method = 8;
  } catch (_e) {}
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const loc = new DataView(new ArrayBuffer(30)),
    cen = new DataView(new ArrayBuffer(46)),
    end = new DataView(new ArrayBuffer(22));
  put(loc, [
    [0, 0x04034b50, 4],
    [4, 20, 2],
    [6, 0x0800, 2],
    [8, method, 2],
    [10, time, 2],
    [12, date, 2],
    [14, crc, 4],
    [18, data.length, 4],
    [22, bytes.length, 4],
    [26, nm.length, 2],
    [28, 0, 2],
  ]);
  put(cen, [
    [0, 0x02014b50, 4],
    [4, 20, 2],
    [6, 20, 2],
    [8, 0x0800, 2],
    [10, method, 2],
    [12, time, 2],
    [14, date, 2],
    [16, crc, 4],
    [20, data.length, 4],
    [24, bytes.length, 4],
    [28, nm.length, 2],
    [30, 0, 2],
    [32, 0, 2],
    [34, 0, 2],
    [36, 0, 2],
    [38, 0, 4],
    [42, 0, 4],
  ]);
  const cdOff = 30 + nm.length + data.length,
    cdLen = 46 + nm.length;
  put(end, [
    [0, 0x06054b50, 4],
    [4, 0, 2],
    [6, 0, 2],
    [8, 1, 2],
    [10, 1, 2],
    [12, cdLen, 4],
    [16, cdOff, 4],
    [20, 0, 2],
  ]);
  return new Blob([loc.buffer, nm, data, cen.buffer, nm, end.buffer], { type: "application/zip" });
}
// A .zip's files: [{name, method, crc, csize, size, off}], from its central directory.
export function zipEntries(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      e = i;
      break;
    }
  if (e < 0) throw new Error("not a zip");
  const n = v.getUint16(e + 10, true),
    out = [];
  let o = v.getUint32(e + 16, true);
  for (let k = 0; k < n; k++) {
    if (v.getUint32(o, true) !== 0x02014b50) throw new Error("bad zip");
    out.push({
      method: v.getUint16(o + 10, true),
      crc: v.getUint32(o + 16, true),
      csize: v.getUint32(o + 20, true),
      size: v.getUint32(o + 24, true),
      off: v.getUint32(o + 42, true),
      name: new TextDecoder().decode(b.subarray(o + 46, o + 46 + v.getUint16(o + 28, true))),
    });
    o += 46 + v.getUint16(o + 28, true) + v.getUint16(o + 30, true) + v.getUint16(o + 32, true);
  }
  return out;
}
// One file out of a .zip, checked against its CRC so a damaged one is refused. `max`: the most bytes to unpack.
export async function unzipEntry(b, ent, max = 64 * 1024 * 1024) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint32(ent.off, true) !== 0x04034b50) throw new Error("bad zip");
  if (ent.size > max) throw new Error("too big");
  const start = ent.off + 30 + v.getUint16(ent.off + 26, true) + v.getUint16(ent.off + 28, true),
    raw = b.subarray(start, start + ent.csize);
  const out =
    ent.method === 0 ? raw : ent.method === 8 ? await pipeBytes(raw, new DecompressionStream("deflate-raw")) : null;
  if (!out || out.length !== ent.size || crc32(out) !== ent.crc) throw new Error("damaged");
  return out;
}
// Reads the first .jsonl (or only) file from a .zip.
export async function unzipFirst(b) {
  let pick = null;
  for (const ent of zipEntries(b))
    if (!pick || (/\.jsonl$/i.test(ent.name) && !/\.jsonl$/i.test(pick.name))) pick = ent;
  if (!pick) throw new Error("bad zip");
  return unzipEntry(b, pick, Number.POSITIVE_INFINITY);
}
