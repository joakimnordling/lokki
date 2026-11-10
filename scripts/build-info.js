// What a build was made from, shown in Preferences: the package version, the commit and the build date.
// esbuild puts it in place of the global __LOKKI_BUILD__ (see src/core/version.js).
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch (_e) {
    return "";
  }
}

export async function buildInfo() {
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  return { version, commit: commit(), built: new Date().toISOString().slice(0, 10) };
}

/** The esbuild `define` option that bakes the build info into the bundle. */
export const buildDefine = async () => ({ __LOKKI_BUILD__: JSON.stringify(await buildInfo()) });
