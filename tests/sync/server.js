// Starts the Python sync server (servers/python) in test mode on a free port, with a temporary SQLite database.
// Needs uv: https://docs.astral.sh/uv/
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const project = resolve(import.meta.dirname, "../../servers/python");

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

export async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "lokki-server-"));
  const port = await freePort();
  const child = spawn("uv", ["run", "--project", project, "lokki-server", "serve", "--port", String(port)], {
    env: {
      ...process.env,
      LOKKI_DATABASE_URL: `sqlite+aiosqlite:///${join(dir, "lokki.db")}`,
      LOKKI_TEST_MODE: "true",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (d) => {
    errors += d;
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      if ((await fetch(`${url}/v1/info`)).ok) break;
    } catch {}
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`the server didn't start:\n${errors}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url,
    /** A new, empty vault: its name and {write, read} tokens. */
    async vault() {
      const response = await fetch(`${url}/v1/test/vaults`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return response.json();
    },
    async stop() {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
