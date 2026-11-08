// A tiny static server for development: serves the repository root, then public/ for anything not found there.
//   npm run serve            -> http://localhost:8080
//   PORT=3000 npm run serve
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dirs = [root, join(root, "public")];
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// Packages the unbundled modules import through the import map in index.html
const vendor = { "/vendor/hash-wasm.js": join(root, "node_modules", "hash-wasm", "dist", "index.esm.min.js") };

async function find(path) {
  if (vendor[path]) return vendor[path];
  for (const dir of dirs) {
    const file = normalize(join(dir, path));
    if (!file.startsWith(dir)) return null;
    try {
      const s = await stat(file);
      if (s.isFile()) return file;
      if (s.isDirectory()) {
        const index = join(file, "index.html");
        if ((await stat(index).catch(() => null))?.isFile()) return index;
      }
    } catch {}
  }
  return null;
}

export function serve(port = 8080) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.startsWith("/node_modules/") ? null : await find(path);
    if (!file) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": types[extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 8080;
  await serve(port);
  console.log(`Lokki at http://localhost:${port}`);
}
