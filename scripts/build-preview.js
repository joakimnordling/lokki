// Builds a preview of the app as one self-contained page, dist/preview/lokki-preview.html: the built site's script,
// stylesheet and fonts inlined. It opens as a new user sees it, empty, with its own storage; Try with Demo Data shows
// made-up logs. For trying a change out as a claude.ai artifact before it's merged; it has no service worker, so it
// doesn't work offline or update itself.
//   npm run build:preview
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildSite } from "./build-site.js";

const root = resolve(import.meta.dirname, "..");
const site = join(root, "dist", "site");
const out = join(root, "dist", "preview");

await buildSite();
let html = await readFile(join(site, "index.html"), "utf8");
const assets = await readdir(join(site, "assets"));
const jsName = assets.find((f) => f.endsWith(".js"));
const cssName = assets.find((f) => f.endsWith(".css"));

// The stylesheet, with its fonts as data: URLs
let css = await readFile(join(site, "assets", cssName), "utf8");
css = css.replace(/url\(["']?\.\.\/fonts\/([^"')]+)["']?\)/g, (_m, f) => `url("data:font/woff2;base64,__FONT_${f}__")`);
for (const f of new Set([...css.matchAll(/__FONT_([^_]+?\.woff2)__/g)].map((m) => m[1])))
  css = css.replaceAll(`__FONT_${f}__`, (await readFile(join(site, "fonts", f))).toString("base64"));
const js = (await readFile(join(site, "assets", jsName), "utf8")).replaceAll("</script", "<\\/script");
const icon = (await readFile(join(site, "icons", "favicon.svg"))).toString("base64");

const swap = (from, to) => {
  if (!html.includes(from)) throw new Error(`index.html: ${from} not found`);
  html = html.replace(from, () => to); // a function, so "$" in the script is never read as a pattern
};
swap(`<link rel="stylesheet" href="assets/${cssName}">`, `<style>\n${css}\n</style>`);
swap(`<script type="module" src="assets/${jsName}"></script>`, `<script type="module">\n${js}\n</script>`);
html = html.replace(/<script>if\("serviceWorker"[^<]*<\/script>\n?/, "");
html = html.replace(/<link rel="(?:icon|apple-touch-icon|manifest|preload)"[^>]*>\n/g, "");
html = html.replace(
  "<title>Lokki</title>",
  `<title>Lokki Preview</title>\n<link rel="icon" href="data:image/svg+xml;base64,${icon}">`,
);
// The artifact host wraps the page in its own document (doctype, charset and viewport), so the page is just its contents
html = html
  .replace(/^<!doctype html>\n<html[^>]*>\n<head>\n/i, "")
  .replace(/<meta (?:charset|name="viewport")[^>]*>\n/g, "")
  .replace("</head>\n<body>\n", "")
  .replace(/<\/body>\n<\/html>\n?$/, "");
await mkdir(out, { recursive: true });
await writeFile(join(out, "lokki-preview.html"), html);
console.log(`dist/preview/lokki-preview.html: ${Math.round(html.length / 1024)} KB`);
