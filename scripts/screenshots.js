// The README's screenshots, in light and dark: a year of made-up logs, restored from a backup into the built site,
// photographed at a phone's size with the clock stopped, then losslessly compressed (oxipng).
// Run with: npm run screenshots          (writes docs/screenshots/*.png)
// The same data and clock every time, so the images only change when the app's looks do.
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { losslessCompressPng } from "@napi-rs/image";
import { chromium } from "playwright";
import { uuid5 } from "../src/core/ids.js";

const root = resolve(import.meta.dirname, "..");
const site = join(root, "dist", "site");
const out = join(root, "docs", "screenshots");

// "Now" in the screenshots: a Sunday evening, after a year of logs
const NOW = new Date(2026, 10, 8, 20, 30);
const FIRST = new Date(2025, 10, 1);

// A small seeded random number generator (mulberry32): the same numbers every run
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(20261108);
const between = (a, b) => a + r() * (b - a);
const round = (x, step) => +(Math.round(x / step) * step).toFixed(2);
const p2 = (n) => String(n).padStart(2, "0");
const at = (d, h, m) =>
  `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(Math.floor(h))}:${p2(Math.floor(m))}:00`;
// How far into summer a day is: 0 in midwinter, 1 at midsummer
const summer = (d) => (1 - Math.cos(((d - new Date(d.getFullYear(), 0, 1)) / 864e5 / 365) * 2 * Math.PI)) / 2;

const METRICS = [
  { id: "running", name: "Running", type: "Fitness", mode: "totals", gran: "weekly" },
  { id: "body-weight", name: "Body Weight", type: "Health", mode: "avg", gran: "monthly" },
  { id: "cycling", name: "Cycling", type: "Fitness" },
  { id: "swimming", name: "Swimming", type: "Fitness" },
  { id: "steps", name: "Steps", type: "Health" },
  { id: "sleep", name: "Sleep", type: "Health" },
  { id: "coffee", name: "Coffee", type: "Food & Drink" },
  { id: "reading", name: "Reading", type: "Hobbies" },
  { id: "meditation", name: "Meditation", type: "Health" },
];

// Each day's entries for each metric: [metric, hour, minute, value]
function* day(d, i) {
  const wd = d.getDay(); // 0 Sunday
  const s = summer(d);
  // Running: three or four times a week, longer in summer; an easy week now and then
  const easy = Math.floor(i / 7) % 6 === 5;
  if ([2, 4, 6].includes(wd) || (wd === 0 && r() < 0.4))
    if (r() < (easy ? 0.4 : 0.85)) {
      const long = wd === 6 ? 1.6 : 1;
      yield ["running", between(6, 8), between(0, 59), round(between(4.5, 7.5) * long * (0.7 + 0.6 * s), 0.1)];
    }
  // Cycling: mostly in the warmer half of the year, like running
  if ((wd === 1 || wd === 5 || wd === 0) && r() < 0.15 + 0.8 * s)
    yield ["cycling", 17, between(0, 59), Math.round(between(12, 30) * (0.6 + 0.8 * s))];
  // Steps: every evening, more in summer
  yield ["steps", 21, between(30, 59), Math.round(between(5500, 9500) + 3500 * s)];
  // Sleep: every morning, hours
  yield ["sleep", 7, between(30, 59), round(between(6.3, 8.4) + (wd === 0 || wd === 6 ? 0.6 : 0), 0.25)];
  // Meditation: some mornings, minutes
  if (r() < 0.45) yield ["meditation", 8, between(0, 59), [5, 10, 10, 15, 20][Math.floor(r() * 5)]];
  // Body weight: most mornings, from about 86 kg down to about 79, with plateaus and day-to-day noise
  if (r() < 0.75) {
    const trend = 86 - 7 * (i / 372) + 0.8 * Math.sin(i / 23);
    yield ["body-weight", 7, between(0, 30), round(trend + between(-0.6, 0.6), 0.1)];
  }
  // Swimming: once a week, a bit more in summer
  if (wd === 3 && r() < 0.8) yield ["swimming", 18, between(0, 59), round(between(1, 1.6) + 0.5 * s, 0.05)];
  // Coffee: every day, more on weekdays
  const cups = Math.max(1, Math.round(between(1.5, 3.5) + (wd > 0 && wd < 6 ? 0.8 : -0.3)));
  yield ["coffee", 15, between(0, 59), cups];
  // Reading: most evenings, more at weekends and in winter
  if (r() < 0.7)
    yield ["reading", 22, between(0, 59), Math.round(between(10, 40) * (wd % 6 === 0 ? 1.6 : 1) * (1.3 - 0.4 * s))];
}

async function backup() {
  let u = NOW.getTime() - 400 * 864e5;
  const lines = [{ kind: "header", format: "lokki", version: 1, exported: NOW.toISOString(), app: "lokki-web" }];
  for (const m of METRICS)
    lines.push({ kind: "metric", created: at(FIRST, 8, 0), mode: null, gran: null, ...m, u: u++, deleted: false });
  let i = 0;
  for (const d = new Date(FIRST); d <= NOW; d.setDate(d.getDate() + 1), i++)
    for (const [metric, h, m, v] of day(d, i)) {
      const t = at(d, h, m);
      if (t > at(NOW, NOW.getHours(), NOW.getMinutes())) continue;
      lines.push({ kind: "entry", id: await uuid5(`${metric}|${t}`), metric, t, v, n: null, u: u++, d: false });
    }
  lines.push({ kind: "footer" });
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

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
const work = await mkdtemp(join(tmpdir(), "lokki-screenshots-"));
const file = join(work, "lokki-backup.jsonl");
await writeFile(file, await backup());
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
    await pg.goto(url);
    await pg.waitForSelector("#cCreate");
    // Restore the made-up year, as a person would: Preferences → Restore from Backup
    await pg.click("#hSet");
    const [chooser] = await Promise.all([pg.waitForEvent("filechooser"), pg.click("#sRes")]);
    await chooser.setFiles(file);
    await pg.click("#sDone");
    await pg.waitForFunction(() => /Restored/.test(document.querySelector(".toast")?.textContent || ""));
    // Back to a clean home screen, without the reminder to back up or sync
    await pg.addStyleTag({ content: ".toast, .note { display: none !important }" });
    while (await pg.$("#hBack")) await pg.click("#hBack");
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
  await rm(work, { recursive: true, force: true });
}
