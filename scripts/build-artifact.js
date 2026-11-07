// Builds the single-file page published as the claude.ai artifact: the modules bundled into one script, the
// stylesheet inline and the font embedded, so the page loads nothing from elsewhere.
//   npm run build:artifact   -> dist/lokki-artifact.html
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "dist", "lokki-artifact.html");

export async function buildArtifact() {
  const html = await readFile(join(root, "index.html"), "utf8");
  const body = /<!-- app:begin -->\n([\s\S]*?)<!-- app:end -->/.exec(html)?.[1];
  if (!body) throw new Error("index.html: app:begin/app:end markers not found");

  let css = await readFile(join(root, "public", "styles", "app.css"), "utf8");
  const fonts = [...css.matchAll(/url\(\.\.\/(fonts\/[\w.-]+\.woff2)\)/g)];
  for (const [ref, path] of fonts) {
    const b64 = (await readFile(join(root, "public", path))).toString("base64");
    css = css.replace(ref, `url(data:font/woff2;base64,${b64})`);
  }

  const js = await build({
    entryPoints: [join(root, "src", "app.js")],
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: true,
    legalComments: "inline",
    write: false,
  });
  const script = js.outputFiles[0].text;
  for (const [name, text] of [
    ["script", script],
    ["style", css],
  ])
    if (/<\/(script|style)/i.test(text)) throw new Error(`the ${name} contains a closing tag`);

  const page = `<title>Lokki</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${css}</style>
${body}<script>
${script}</script>
`;
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(out, page);
  return { out, bytes: Buffer.byteLength(page) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { out: file, bytes } = await buildArtifact();
  console.log(`${file} (${Math.round(bytes / 1024)} KiB)`);
}
