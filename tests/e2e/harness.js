// End-to-end harness: several "devices" (separate browser contexts) sharing one simulated claude.ai database.
//   /       the built claude.ai artifact (dist/lokki-artifact.html), with the database and downloads
//   /nodb   the same page with downloads only (a copy that doesn't sync)
//   /dev/   the unbundled modules (index.html), with the database and downloads
// Add "#off" to start a page offline.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../..");
const ALLOW = "/\\.(gif|png|jpe?g|webp|mp4|webm|mov|txt|json|md|docx|pptx|epub|csv|ttf|html|svg|pdf|xlsx|zip|fig)$/i";

// Runs in the page before the app: a stand-in for window.claude.
const mock = `(() => {
  const nodb = location.pathname.startsWith("/nodb");
  const subs = {};
  let offline = location.hash === "#off";
  window.__setOffline = (v) => { offline = v; if (!v) for (const c in subs) window.__srvSub(c); };
  window.__deliver = (c, p) => { if (offline) return; for (const fn of subs[c] || []) fn(p); };
  const snap = (p) => ({ docs: p.docs.map((d) => ({ id: d.id, data: () => d.data })), size: p.docs.length, empty: !p.docs.length,
    metadata: { fromCache: false, hasPendingWrites: false },
    docChanges: () => p.changes.map((ch) => ({ type: ch.type, doc: { id: ch.id, data: () => ch.data } })) });
  const err = (c) => Object.assign(new Error(c), { code: c });
  const db = {
    collection(c) { return { onSnapshot(next) { subs[c] = [(p) => next(snap(p))]; window.__srvSub(c); return () => {}; } }; },
    doc(p) {
      const w = async (op, data) => { if (offline) throw err("unavailable"); const r = await window.__srvWrite(op, p, data); if (r) throw err(r); };
      return { set: (d) => w("set", d), update: (d) => w("update", d), delete: () => w("delete") };
    },
  };
  const downloads = { save: async (r) => {
    if (!${ALLOW}.test(r.filename)) throw Object.assign(new Error("ext"), { code: "rejected_extension" });
    window.__saved = r; return { status: "saved" };
  } };
  window.claude = { use: async (n) => (n === "db" ? (nodb ? null : db) : n === "downloads" ? downloads : null) };
})();`;

const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};
const clone = (x) => JSON.parse(JSON.stringify(x));
// The claude.ai database merges nested objects key by key and replaces everything else.
function merge(a, b) {
  for (const k in b) {
    const x = a[k],
      y = b[k];
    if (y && typeof y === "object" && !Array.isArray(y) && x && typeof x === "object" && !Array.isArray(x)) merge(x, y);
    else a[k] = clone(y);
  }
  return a;
}

export async function startHarness() {
  const artifact = await readFile(join(root, "dist", "lokki-artifact.html"), "utf8");
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${artifact}</body></html>`;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/" || path.startsWith("/nodb")) return res.writeHead(200, { "content-type": "text/html" }).end(page);
    if (path.startsWith("/dev/")) {
      const rel = path.slice(5) || "index.html";
      for (const dir of [root, join(root, "public")]) {
        const file = resolve(dir, rel);
        if (!file.startsWith(dir)) break;
        try {
          const body = await readFile(file);
          const ext = file.slice(file.lastIndexOf("."));
          return res.writeHead(200, { "content-type": types[ext] || "text/html" }).end(body);
        } catch {}
      }
    }
    res.writeHead(404).end();
  });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch();

  const store = { metrics: new Map(), "entries-v2": new Map() };
  const writes = [];
  const errors = [];
  const subs = new Map(); // page -> Set(collection)

  async function broadcast(c, changes) {
    for (const [pg, cs] of subs)
      if (cs.has(c)) await pg.evaluate(([c, p]) => window.__deliver(c, p), [c, { docs: [], changes }]).catch(() => {});
  }

  // A new device: its own browser context (own IndexedDB and localStorage).
  async function device(path = "/", { viewport = { width: 393, height: 852 }, wait = 1500 } = {}) {
    const ctx = await browser.newContext({ viewport, acceptDownloads: false });
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errors.push(e.message));
    await pg.addInitScript(mock);
    await pg.exposeBinding("__srvSub", async ({ page }, c) => {
      if (!subs.has(page)) subs.set(page, new Set());
      subs.get(page).add(c);
      const docs = [...store[c]].map(([id, data]) => ({ id, data }));
      setTimeout(
        () =>
          page
            .evaluate(
              ([c, p]) => window.__deliver(c, p),
              [c, { docs, changes: docs.map((d) => ({ type: "added", ...d })) }],
            )
            .catch(() => {}),
        20,
      );
    });
    await pg.exposeBinding("__srvWrite", async (_src, op, p, data) => {
      const [c, id] = p.split("/");
      const m = store[c],
        existed = m.has(id);
      if (op === "update" && !existed) return "invalid_argument";
      if (op === "set") m.set(id, clone(data));
      else if (op === "update") merge(m.get(id), data);
      else if (existed) m.delete(id);
      else return null;
      writes.push({ op, path: p, keys: op === "update" ? Object.keys(data.e || data).length : null });
      await broadcast(c, [{ type: op === "delete" ? "removed" : existed ? "modified" : "added", id, data: m.get(id) }]);
      return null;
    });
    await pg.goto(base + path);
    if (wait) await pg.waitForTimeout(wait);
    return pg;
  }

  function seed(data) {
    for (const [id, d] of data.metrics) store.metrics.set(id, clone(d));
    for (const [id, d] of data.docs) store["entries-v2"].set(id, clone(d));
  }

  async function close() {
    await browser.close();
    server.close();
  }
  return { base, browser, store, writes, errors, device, seed, close };
}

// --- helpers used by several suites ---

// Live entries and the outbox size, as one device sees them.
export const counts = (pg) =>
  pg.evaluate(() => {
    const L = window.__lokki;
    let live = 0;
    for (const r of L.recs.values()) if (!r.d && !L.metricAll.get(r.m)?.deleted) live++;
    return { live, outbox: L.outbox.size };
  });
// The i-th live entry of a metric, oldest first.
export const pick = (pg, m, i) =>
  pg.evaluate(
    ([m, i]) =>
      [...window.__lokki.recs.values()].filter((r) => r.m === m && !r.d).sort((x, y) => (x.t < y.t ? -1 : 1))[i],
    [m, i],
  );
// Back to the metric list with no sheet or toast open.
export async function home(pg) {
  await pg.evaluate(() => {
    for (const t of document.querySelectorAll(".toast")) t.remove();
    document.querySelector("#layer").innerHTML = "";
  });
  while ((await pg.$("#hBack")) || (await pg.$("#eBack"))) await pg.click((await pg.$("#eBack")) ? "#eBack" : "#hBack");
}
// Waits for the app to offer a file, and returns it as {filename, bytes}.
export async function saved(pg) {
  await pg.waitForFunction(() => window.__saved);
  const r = await pg.evaluate(async () => {
    const s = window.__saved;
    window.__saved = null;
    const d =
      s.data instanceof Blob
        ? new Uint8Array(await s.data.arrayBuffer())
        : typeof s.data === "string"
          ? new TextEncoder().encode(s.data)
          : new Uint8Array(s.data);
    return { filename: s.filename, bytes: Array.from(d) };
  });
  return { filename: r.filename, bytes: Buffer.from(r.bytes) };
}
export const toastText = (pg, re) =>
  pg
    .waitForFunction((src) => new RegExp(src).test(document.querySelector(".toast")?.textContent || ""), re.source, {
      timeout: 30000,
    })
    .then(() => pg.textContent(".toast"));
