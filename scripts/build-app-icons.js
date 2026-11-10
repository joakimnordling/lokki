// The app icon's images, rendered with Playwright's Chromium from public/icons/lokki-icon.svg and favicon.svg.
// The maskable icon (Android) draws the graph smaller, so it stays inside the circle a launcher may crop it to.
// Run with: npm run app-icons
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const dir = join(resolve(import.meta.dirname, ".."), "public", "icons");
const icon = await readFile(join(dir, "lokki-icon.svg"), "utf8");
const favicon = await readFile(join(dir, "favicon.svg"), "utf8");
const maskable = icon
  .replace(/translate\([^)]*\) scale\([^)]*\)/, "translate(2.4 2.4) scale(0.8)")
  .replace('stroke-width="1.8"', 'stroke-width="1.98"');

const outputs = [
  ["lokki-icon-1024.png", icon, 1024],
  ["icon-512.png", icon, 512],
  ["icon-192.png", icon, 192],
  ["apple-touch-icon.png", icon, 180],
  ["apple-touch-icon-167.png", icon, 167],
  ["apple-touch-icon-152.png", icon, 152],
  ["apple-touch-icon-120.png", icon, 120],
  ["icon-maskable-512.png", maskable, 512],
  ["favicon-32.png", favicon, 32, true],
  ["favicon-16.png", favicon, 16, true],
];

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
for (const [name, svg, size, transparent] of outputs) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const sized = svg.replace(
    /<svg ([^>]*?)(?: width="\d+" height="\d+")?>/,
    `<svg $1 width="${size}" height="${size}">`,
  );
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`);
  await page.screenshot({ path: join(dir, name), omitBackground: !!transparent });
  await page.close();
  console.log(`${name} (${size}×${size})`);
}
await browser.close();
