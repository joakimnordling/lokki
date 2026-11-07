// CSV export and import, metric names and per-device settings.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeData, oldLoggrFiles } from "./fixtures.js";
import { home, saved, startHarness, toastText } from "./harness.js";

describe("CSV and names", () => {
  let h, data, dir, A, B;
  const keep = async (s) => {
    const f = join(dir, s.filename);
    await writeFile(f, s.bytes);
    return f;
  };
  async function imp(pg, files, viaMetric) {
    await pg.evaluate(() => {
      for (const t of document.querySelectorAll(".toast")) t.remove();
    });
    if (viaMetric) await pg.click("#tbEntries");
    else {
      await home(pg);
      await pg.click("#hSet");
    }
    const [chooser] = await Promise.all([pg.waitForEvent("filechooser"), pg.click(viaMetric ? "#aImp" : "#sImp")]);
    await chooser.setFiles(files);
    return toastText(pg, /Imported|Nothing new|No entries/);
  }
  const content = (pg) =>
    pg.evaluate(() => {
      const L = window.__lokki,
        c = {};
      for (const r of L.recs.values()) {
        const m = L.metricAll.get(r.m);
        if (r.d || !m || m.deleted) continue;
        const k = [m.name, r.t, r.v, r.n || ""].join("|");
        c[k] = (c[k] || 0) + 1;
      }
      return c;
    });

  before(async () => {
    h = await startHarness();
    data = await makeData();
    h.seed(data);
    dir = await mkdtemp(join(tmpdir(), "lokki-"));
    A = await h.device();
    B = await h.device("/nodb");
  });
  after(() => h.close());

  let all;
  it("exports everything as Metric,Date,Value,Note", async () => {
    await home(A);
    await A.click("#hSet");
    await A.click("#sExp");
    const s = await saved(A);
    assert.match(s.filename, /^lokki-export-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = s.bytes.toString().split("\n");
    assert.equal(lines[0], "Metric,Date,Value,Note");
    assert.equal(lines.filter(Boolean).length, data.entries.length + 1);
    assert.ok(lines.includes(lines.find((l) => l.endsWith(',"with a note, and a comma"'))));
    all = await keep(s);
  });

  it("imports it into an empty copy with identical content, and a second time adds nothing", async () => {
    assert.match(await imp(B, [all]), /Imported/);
    assert.deepEqual(await content(B), await content(A));
    assert.match(await imp(B, [all]), /Nothing new/);
  });

  it("reads the old Loggr app's files and finds nothing new in them", async () => {
    const files = [];
    for (const [name, text] of oldLoggrFiles(data.entries)) {
      files.push(join(dir, name));
      await writeFile(files.at(-1), text);
    }
    assert.match(await imp(B, files), /Nothing new/);
  });

  it("exports and re-imports one metric from its ↓↑ button", async () => {
    await home(A);
    await A.click("text=Running");
    await A.click("#tbEntries");
    await A.click("#aExp");
    const s = await saved(A);
    assert.equal(s.filename, "Running.csv");
    assert.equal(s.bytes.toString().split("\n")[0], "Date,Value,Note");
    assert.match(await imp(A, [await keep(s)], true), /Nothing new/);
  });

  it("recognises a name typed with a separate accent as a duplicate", async () => {
    await home(A);
    await A.click("#cCreate");
    await A.fill("#mName", "Café");
    await A.click("#sDone");
    assert.match(await A.textContent("#mErr"), /already have/);
    await A.click("#sCancel");
  });

  it("cleans up names, and makes export file names safe", async () => {
    await A.click("#cCreate");
    await A.fill("#mName", "  Walk/Run​  ");
    await A.click("#sDone");
    await A.waitForTimeout(300);
    assert.ok(await A.evaluate(() => [...window.__lokki.metricAll.values()].some((m) => m.name === "Walk/Run")));
    await A.click("text=Walk/Run");
    await A.click("#tbAdd");
    await A.fill("#eVal", "3");
    await A.click("#sDone");
    await A.click("#tbEntries");
    await A.click("#aExp");
    assert.equal((await saved(A)).filename, "Walk-Run.csv");
  });

  it("carries over settings saved under the old Loggr names", async () => {
    const C = await h.device("/nodb", { wait: 0 });
    await C.evaluate(() => localStorage.setItem("loggr:look", '"dark"'));
    await C.reload();
    await C.waitForTimeout(400);
    assert.equal(await C.evaluate(() => document.documentElement.dataset.look), "dark");
  });

  it("had no script errors", () => assert.deepEqual(h.errors, []));
});
