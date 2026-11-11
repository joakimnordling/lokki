// Back Up and Restore from Backup.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { makeData } from "./fixtures.js";
import { home, pick, saved, startHarness } from "./harness.js";

// Read with Python's zipfile, an implementation independent of the app's.
const unzip = (f) =>
  execFileSync(
    "python3",
    [
      "-I",
      "-c",
      "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;sys.stdout.write(z.read(z.namelist()[0]).decode())",
      f,
    ],
    { maxBuffer: 1e8 },
  ).toString();

describe("backup and restore", () => {
  let h, data, dir, A, B;
  const file = async (name, content) => {
    const f = join(dir, name);
    await writeFile(f, content);
    return f;
  };
  async function backup(pg, tag) {
    await home(pg);
    await pg.click("#hSet");
    const s = await saved(pg, () => pg.click("#sBak"));
    return { name: s.filename, f: await file(`${tag}-${s.filename}`, s.bytes) };
  }
  async function openRestore(pg, f) {
    await home(pg);
    await pg.click("#hSet");
    const [chooser] = await Promise.all([pg.waitForEvent("filechooser"), pg.click("#sRes")]);
    await chooser.setFiles(f);
    await pg.waitForSelector(".sheet");
    await pg.waitForTimeout(200);
    return (await pg.textContent(".sheet")).replace(/\s+/g, " ");
  }
  async function restore(pg, f, bring) {
    const text = await openRestore(pg, f);
    if (bring && (await pg.$("#rBring"))) await pg.check("#rBring");
    if (await pg.$("#sDone")) {
      await pg.click("#sDone");
      await pg.waitForFunction(
        () => /Restored|Nothing restored/.test(document.querySelector(".toast")?.textContent || ""),
        null,
        {
          timeout: 30000,
        },
      );
    } else await pg.click("#sCancel");
    await pg.waitForTimeout(800);
    return text;
  }
  const snapshot = (pg) =>
    pg.evaluate(() => {
      const L = window.__lokki,
        e = {},
        m = {};
      for (const r of L.recs.values())
        if (!r.d && !L.metricAll.get(r.m)?.deleted) e[r.id] = [r.m, r.t, r.v, r.n || ""].join("|");
      for (const [id, x] of L.metricAll) {
        // the chart view is per device: saved on it, or (from before) on the metric
        const view = JSON.parse(localStorage.getItem(`lokki:view:${id}`) || "null") || x;
        m[id] = x.deleted ? "DELETED" : [x.name, x.type || "", view.mode || "", view.gran || ""].join("|");
      }
      return { e, m };
    });
  const sameAs = async (x, y) => assert.deepEqual(await snapshot(x), await snapshot(y));

  before(async () => {
    h = await startHarness();
    data = await makeData();
    dir = await mkdtemp(join(tmpdir(), "lokki-"));
    A = await h.device("/site/", { data });
    B = await h.device();
  });
  after(() => h.close());

  let k1, lines;
  it("saves a .zip of JSON Lines: header first, bare footer last, a kind on every line", async () => {
    k1 = await backup(A, "1");
    assert.match(k1.name, /^lokki-backup-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
    lines = unzip(k1.f)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(lines[0].kind + lines[0].format + lines[0].version + lines[0].app, "headerlokki1lokki-web");
    assert.equal(JSON.stringify(lines.at(-1)), '{"kind":"footer"}');
    assert.ok(lines.every((l) => l.kind));
    assert.equal(lines.filter((l) => l.kind === "entry").length, data.entries.length);
    assert.deepEqual(
      lines.find((l) => l.id === "running"),
      {
        kind: "metric",
        id: "running",
        name: "Running",
        type: "Fitness",
        mode: "totals",
        gran: "monthly",
        created: "2023-01-01T08:00:00",
        u: data.metrics.get("running").u,
        g: 0,
        deleted: false,
      },
    );
  });

  it("restores into an empty copy identically, and a second time changes nothing", async () => {
    await restore(B, k1.f);
    await sameAs(A, B);
    assert.match(await openRestore(B, k1.f), /Nothing to change/);
    await B.click("#sCancel");
  });

  let k2;
  it("carries edits, deletions, year moves, renames and new metrics", async () => {
    const [e1, e2, e3] = [
      await pick(A, "body-weight", 3),
      await pick(A, "body-weight", 4),
      await pick(A, "cycling", 1),
    ];
    await A.evaluate(
      async ([e1, e2, e3]) => {
        await window.__test.edit({ id: e1.id }, e1.t, 99.9, "edited");
        window.__test.del({ id: e2.id });
        await window.__test.edit({ id: e3.id }, "2012-01-01T10:00:00", e3.v, "");
      },
      [e1, e2, e3],
    );
    await home(A);
    await A.click("text=Reading");
    await A.click("#hEdit");
    await A.fill("#mName", "Sleep");
    await A.click("#sDone");
    await home(A);
    await A.click("#cCreate");
    await A.fill("#mName", "Walk/Run");
    await A.click("#sDone");
    const id = await A.evaluate(() => [...window.__lokki.metricAll].find(([, m]) => m.name === "Walk/Run")[0]);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4/, "new metrics get a UUIDv4");
    await A.evaluate((id) => window.__test.add(id, "2026-11-07T12:00:00", 5, ""), id);
    await A.waitForTimeout(800);
    k2 = await backup(A, "2");
    await restore(B, k2.f);
    await sameAs(A, B);
  });

  it("an older backup doesn't overwrite anything newer", async () => {
    await restore(B, k1.f);
    await sameAs(A, B);
  });

  it("brings back a deleted metric only when asked, under its original id", async () => {
    const runs = data.entries.filter((e) => e.m === "running").length;
    await home(A);
    await A.click("text=Running");
    await A.click("#tbDelete");
    await A.click("#dYes");
    await A.waitForTimeout(500);
    const text = await openRestore(A, k2.f);
    assert.match(text, /Bring back what you've deleted since/);
    assert.ok(text.includes(`Running (${runs.toLocaleString("fi-FI").replace(/\s/g, " ")} entries)`), text);
    await A.click("#sDone");
    await A.waitForTimeout(800);
    assert.equal(
      await A.evaluate(() => window.__lokki.metricAll.get("running")?.deleted),
      true,
      "not ticked: stays deleted",
    );
    await restore(A, k2.f, true);
    const [m, n, view] = await A.evaluate(() => [
      window.__lokki.metricAll.get("running"),
      [...window.__lokki.recs.values()].filter((r) => r.m === "running" && !r.d).length,
      JSON.parse(localStorage.getItem("lokki:view:running")), // the view is per device and survives
    ]);
    assert.deepEqual([m.name, m.type, view?.mode, !!m.deleted, n], ["Running", "Fitness", "totals", false, runs]);
  });

  describe("damaged and hand-made files", () => {
    let raw, ls;
    before(() => {
      raw = unzip(k2.f);
      ls = raw.trim().split("\n");
    });
    const refused = async (f, re) => {
      const t = await openRestore(B, f);
      assert.match(t, re);
      assert.equal(await B.$("#sDone"), null);
      await B.click("#sCancel");
    };
    it("refuses a file without the footer", async () =>
      refused(await file("cut.jsonl", `${ls.slice(0, -1).join("\n")}\n`), /incomplete/));
    it("refuses a cut-off zip", async () =>
      refused(await file("cut.zip", (await readFile(k2.f)).subarray(0, 20000)), /couldn't be read|incomplete/));
    it("refuses a cut-off gzip", async () =>
      refused(await file("cut.jsonl.gz", gzipSync(raw).subarray(0, 20000)), /couldn't be read|incomplete/));
    it("refuses a file without the header", async () =>
      refused(await file("nohead.jsonl", ls.slice(1).join("\n")), /isn't a Lokki backup/));
    it("points at an invalid line", async () => {
      const bad = [...ls];
      bad[3] = '{"kind":"entry","id":"x","metric":"running"}';
      await refused(await file("badline.jsonl", bad.join("\n")), /Line 4 isn't a valid entry/);
    });
    it("reads a .zip made by another tool, and a .jsonl.gz", async () => {
      const pz = join(dir, "py.zip");
      execFileSync("python3", [
        "-I",
        "-c",
        'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED);z.writestr("x/lokki.jsonl",open(sys.argv[2]).read());z.close()',
        pz,
        await file("raw.jsonl", raw),
      ]);
      assert.match(await openRestore(B, pz), /The backup has/);
      await B.click("#sCancel");
      assert.match(await openRestore(B, await file("gz.jsonl.gz", gzipSync(raw))), /The backup has/);
      await B.click("#sCancel");
    });
    it("restores a hand-edited .jsonl with an extra line of an unknown kind", async () => {
      const ent = JSON.parse(ls.find((l) => l.includes('"kind":"entry"') && l.includes('"d":false')));
      const edited = [...ls];
      edited[edited.findIndex((l) => l.includes(ent.id))] = JSON.stringify({ ...ent, v: 123.4, u: ent.u + 5 });
      edited.splice(1, 0, '{"kind":"settings","future":true}');
      const t = await restore(B, await file("edited.jsonl", `${edited.join("\n")}\n`));
      assert.match(t, /Changes here: 1 entry updated/);
      assert.equal(await B.evaluate((id) => window.__lokki.recs.get(id).v, ent.id), 123.4);
    });
  });

  it("had no script errors", () => assert.deepEqual(h.errors, []));
});
