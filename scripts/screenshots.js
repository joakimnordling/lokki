// The README's screenshots, in light and dark: the built site's demo (?demo, src/core/demo.js), photographed at a
// phone's size with the clock stopped, then losslessly compressed (oxipng).
// Run with: npm run screenshots          (writes docs/screenshots/*.png)
// The same data and clock every time, so the images only change when the app's looks do.
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { losslessCompressPng } from "@napi-rs/image";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const site = join(root, "dist", "site");
const out = join(root, "docs", "screenshots");

// "Now" in the screenshots: a Sunday evening. The demo's year of logs ends here.
const NOW = new Date(2026, 10, 8, 20, 30);

// The built site, served from a local port
function serve() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(site, path);
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// Each screenshot: its name, and how to get there from the home screen
const SHOTS = [
  ["home", async () => {}],
  ["running", async (pg) => detail(pg, "running", "#rankSec")],
  ["weight", async (pg) => detail(pg, "body-weight", ".sec:last-of-type")],
];
// Opens a metric: its chart, with its numbers below
async function detail(pg, id, section) {
  await pg.click(`[data-open="${id}"]`);
  await pg.waitForSelector(section);
  await pg.waitForTimeout(300);
}

execFileSync(process.execPath, [join(root, "scripts", "build-site.js")], { stdio: "ignore" });
const server = await serve();
const url = `http://127.0.0.1:${server.address().port}/`;
await mkdir(out, { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      colorScheme: scheme,
      locale: "en-US",
      timezoneId: "Europe/Helsinki",
    });
    await context.clock.setFixedTime(NOW);
    const pg = await context.newPage();
    await pg.goto(`${url}?demo`);
    await pg.waitForSelector('[data-open="running"]');
    // without the demo's banner
    await pg.addStyleTag({ content: ".note { display: none !important }" });
    for (const [name, go] of SHOTS) {
      while (await pg.$("#hBack")) await pg.click("#hBack");
      await go(pg);
      const path = join(out, `${name}-${scheme}.png`);
      const png = await pg.screenshot();
      const small = await losslessCompressPng(png);
      await writeFile(path, small);
      console.log(`${name}-${scheme}.png: ${Math.round(png.length / 1024)} → ${Math.round(small.length / 1024)} KB`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
