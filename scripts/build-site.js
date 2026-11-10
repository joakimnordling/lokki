// Builds the self-hosted site (GitHub Pages) into dist/site: the modules bundled into one script and the stylesheet,
// both with content hashes in their names, the static files from public/, a service worker for offline use, and
// the CNAME for the custom domain.
//   npm run build:site
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { buildDefine } from "./build-info.js";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "dist", "site");
const DOMAIN = "lokki.jocke.fi";
const hash = (b) => createHash("sha256").update(b).digest("hex").slice(0, 10);

async function files(dir) {
  const list = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) list.push(...(await files(p)));
    else list.push(p);
  }
  return list;
}

export async function buildSite() {
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "assets"), { recursive: true });
  await cp(join(root, "public"), out, {
    recursive: true,
    filter: (src) => !src.includes(`${join("public", "styles")}`),
  });

  const js = (
    await build({
      entryPoints: [join(root, "src", "app.js")],
      bundle: true,
      format: "esm",
      target: "es2022",
      minify: true,
      legalComments: "inline",
      define: await buildDefine(),
      write: false,
    })
  ).outputFiles[0].text;
  const jsName = `assets/app-${hash(js)}.js`;
  await writeFile(join(out, jsName), js);
  // The stylesheet sits one level down, like in public/, so its ../fonts/ paths still work.
  const css = await readFile(join(root, "public", "styles", "app.css"), "utf8");
  const cssName = `assets/app-${hash(css)}.css`;
  await writeFile(join(out, cssName), css);

  let html = await readFile(join(root, "index.html"), "utf8");
  const swap = (from, to) => {
    if (!html.includes(from)) throw new Error(`index.html: ${from} not found`);
    html = html.replace(from, to);
  };
  swap('<link rel="stylesheet" href="styles/app.css">', `<link rel="stylesheet" href="${cssName}">`);
  html = html.replace(/<!-- development only[^>]*-->\n<script type="importmap">[^<]*<\/script>\n/, "");
  swap(
    '<script type="module" src="src/app.js"></script>',
    `<script type="module" src="${jsName}"></script>
<script>if("serviceWorker" in navigator)addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));</script>`,
  );
  await writeFile(join(out, "index.html"), html);
  await writeFile(join(out, "CNAME"), `${DOMAIN}\n`);

  const cached = ["./", ...(await files(out)).map((f) => relative(out, f).split("\\").join("/"))].filter(
    (f) => !/^(CNAME|index\.html|fonts\/OFL\.txt|icons\/lokki-icon-1024\.png)$/.test(f),
  );
  const version = hash(html + cached.join("\n") + js + css);
  const sw = (await readFile(join(root, "scripts", "sw-template.js"), "utf8"))
    .replace("__VERSION__", version)
    .replace("__FILES__", JSON.stringify(cached));
  await writeFile(join(out, "sw.js"), sw);
  return { out, version, files: cached.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await buildSite();
  console.log(`${r.out} (version ${r.version}, ${r.files} files cached offline)`);
}
