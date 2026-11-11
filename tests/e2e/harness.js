// End-to-end harness: "devices" (separate browser contexts, each with its own IndexedDB and localStorage) running
//   /site/  the built GitHub Pages site (dist/site), as people use it
//   /dev/   the unbundled modules (index.html), as in development
// Test data goes straight into a device's IndexedDB before the app reads it.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../..");

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};
export async function startHarness({ args = [] } = {}) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const vendored = {
      "/dev/vendor/hash-wasm.js": ["hash-wasm", "dist", "index.esm.min.js"],
      "/dev/vendor/qr-scanner.min.js": ["qr-scanner", "qr-scanner.min.js"],
      "/dev/vendor/qr-scanner-worker.min.js": ["qr-scanner", "qr-scanner-worker.min.js"],
    }[path];
    if (vendored)
      return res
        .writeHead(200, { "content-type": "text/javascript" })
        .end(await readFile(join(root, "node_modules", ...vendored)));
    const site = path.startsWith("/site/");
    if (path.startsWith("/dev/") || site) {
      const rel = (site ? path.slice(6) : path.slice(5)) || "index.html";
      for (const dir of site ? [join(root, "dist", "site")] : [root, join(root, "public")]) {
        const file = resolve(dir, rel);
        if (!file.startsWith(dir)) break;
        try {
          const body = await readFile(file);
          const ext = file.slice(file.lastIndexOf("."));
          return res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" }).end(body);
        } catch {}
      }
    }
    res.writeHead(404).end();
  });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://localhost:${server.address().port}`;
  // CHROMIUM_PATH: run with a Chromium other than the one this Playwright version downloads (local runs only)
  const browser = await chromium.launch({
    args,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });

  const errors = [];

  /**
   * A new device: its own browser context, with the app loaded and ready. data: test data (fixtures.js) to put on it.
   * The page's console errors are collected in `errors`.
   */
  async function device(path = "/site/", { viewport = { width: 393, height: 852 }, data = null } = {}) {
    const ctx = await browser.newContext({ viewport, acceptDownloads: true });
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errors.push(e.message));
    await pg.goto(base + path);
    await ready(pg);
    if (data) {
      await pg.evaluate((ops) => window.__lokki.idb.write(ops), deviceOps(data));
      await pg.reload();
      await ready(pg);
    }
    return pg;
  }

  async function close() {
    await browser.close();
    server.close();
  }
  return { base, browser, errors, device, close };
}

// The app has loaded this device's copy
export const ready = (pg) => pg.waitForSelector("#cCreate");

// Test data as IndexedDB writes: the metrics, and every entry as a record
function deviceOps({ metrics, docs }) {
  const ops = [...metrics].map(([id, m]) => ["metrics", "put", { id, ...m }]);
  for (const { m, y, e } of docs.values())
    for (const [id, r] of Object.entries(e))
      ops.push(["recs", "put", { id, m, y, t: r.t, v: r.v, ...(r.n ? { n: r.n } : {}), u: r.u }]);
  return ops;
}

// --- helpers used by several suites ---

// Live entries, as one device sees them.
export const counts = (pg) =>
  pg.evaluate(() => {
    const L = window.__lokki;
    let live = 0;
    for (const r of L.recs.values()) if (!r.d && !L.metricAll.get(r.m)?.deleted) live++;
    return { live };
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
// Clicks what makes the app save a file, and returns that file as {filename, bytes}.
export async function saved(pg, click) {
  const [d] = await Promise.all([pg.waitForEvent("download"), click()]);
  return { filename: d.suggestedFilename(), bytes: await readFile(await d.path()) };
}
export const toastText = (pg, re) =>
  pg
    .waitForFunction((src) => new RegExp(src).test(document.querySelector(".toast")?.textContent || ""), re.source, {
      timeout: 30000,
    })
    .then(() => pg.textContent(".toast"));
