// Importing files through the check screen: what was found, a few values, names, date order, and nothing twice.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { home, startHarness, toastText } from "./harness.js";

describe("import", () => {
  let h, P, dir;
  const file = async (name, text) => {
    const f = join(dir, name);
    await writeFile(f, text);
    return f;
  };
  // Picks files from the empty screen, or Preferences once there are metrics; leaves the check screen open
  const choose = async (files, from = "#sImp") => {
    if (from === "#sImp") {
      await home(P);
      await P.click("#hSet");
    }
    const [ch] = await Promise.all([P.waitForEvent("filechooser"), P.click(from)]);
    await ch.setFiles(files);
    await P.waitForSelector("#iGo, .toast");
  };
  const cards = () =>
    P.$$eval(".icard", (cs) =>
      cs.map((c) => ({
        name: c.querySelector(".iname")?.value,
        meta: c.querySelector(".imeta").textContent,
        status: c.querySelector(".istatus").textContent,
        preview: [...c.querySelectorAll(".iprev li:not(.more)")].map((li) =>
          [...li.children].map((x) => x.textContent).join(" "),
        ),
      })),
    );
  const entries = (name) =>
    P.evaluate((n) => {
      const L = window.__lokki;
      const id = [...L.metricAll].find(([, m]) => m.name === n && !m.deleted)?.[0];
      return [...L.recs.values()]
        .filter((r) => r.m === id && !r.d)
        .map((r) => [r.t, r.v, r.n || ""])
        .sort();
    }, name);

  before(async () => {
    h = await startHarness();
    P = await h.device();
    dir = await mkdtemp(join(tmpdir(), "lokki-import-"));
  });
  after(() => h.close());

  it("shows what a spreadsheet's CSV holds before adding anything, from the empty screen", async () => {
    const f = await file(
      "paino.csv",
      "Päivämäärä;Paino;Askeleet;Kommentti\r\n2.11.2026;79,4;8 500;tuulinen\r\n3.11.2026;79,1;10 200;\r\n" +
        "4.11.2026;78,9;;\r\n5.11.2026;79,0;7 800;\r\n6.11.2026;78,6;12 040;\r\n",
    );
    await choose([f], "#cImport");
    const cs = await cards();
    assert.deepEqual(
      cs.map((c) => [c.name, c.meta, c.status]),
      [
        ["Paino", "5 entries · Nov 2026", "New metric"],
        ["Askeleet", "4 entries · Nov 2026", "New metric"],
      ],
    );
    assert.deepEqual(cs[0].preview, ["Nov 2 2026 79,4", "Nov 3 2026 79,1", "Nov 5 2026 79", "Nov 6 2026 78,6"]);
    assert.match(await P.textContent(".ileft"), /Not imported \(1\)/);
    assert.equal(await P.textContent("#iGo"), "Import 9 Entries");
    assert.equal(await P.evaluate(() => window.__lokki.metricAll.size), 0, "nothing added yet");
    // 2.11.2026 could be February 11: asked, and the answer changes the dates
    assert.equal(await P.textContent(".iorder label"), "2.11.2026 is");
    await P.selectOption("#iOrder", "mdy");
    assert.equal((await cards())[0].meta, "5 entries · Feb 2026 – Jun 2026");
    await P.selectOption("#iOrder", "dmy");
    // a card's name decides where it goes; renamed to one you have, it adds to that
    await P.fill("#iName1", "Steps");
    await P.click("#iGo");
    assert.match(await toastText(P, /Imported/), /Imported 9 entries into 2 metrics/);
    assert.deepEqual(await entries("Paino"), [
      ["2026-11-02T12:00:00", 79.4, ""],
      ["2026-11-03T12:00:00", 79.1, ""],
      ["2026-11-04T12:00:00", 78.9, ""],
      ["2026-11-05T12:00:00", 79, ""],
      ["2026-11-06T12:00:00", 78.6, ""],
    ]);
    assert.equal((await entries("Steps")).length, 4);
  });

  it("says what's already there, and adds nothing twice", async () => {
    const f = await file("steps-more.csv", "Date,Steps\n2026-11-02,8500\n2026-11-07,9100\n");
    await choose([f]);
    const [c] = await cards();
    assert.equal(c.status, "Adds to your Steps · 1 already there");
    assert.equal(await P.textContent("#iGo"), "Import 1 Entry");
    await P.click("#iGo");
    assert.match(await toastText(P, /Imported/), /Imported 1 entry$/);
    await choose([f]);
    assert.match(await toastText(P, /Nothing new/), /all 2 entries are already here/);
    assert.equal(await P.$("#iGo"), null);
  });

  it("imports into one metric from its ↓↑ button, picking the column", async () => {
    const f = await file("both.csv", "Date,Weight,Steps\n2026-11-10,78.2,6000\n");
    await home(P);
    await P.click("text=Steps");
    await P.click("#tbEntries");
    await choose([f], "#aImp");
    assert.equal(await P.textContent(".sheet h3"), "Import into Steps");
    assert.equal(await P.$(".iname"), null, "the name is the metric's");
    await P.selectOption("#iCol", "1");
    assert.deepEqual((await cards())[0].preview, ["Nov 10 2026 6\u00a0000"]);
    await P.click("#iGo");
    await toastText(P, /Imported/);
    assert.ok((await entries("Steps")).some(([t, v]) => t === "2026-11-10T12:00:00" && v === 6000));
  });

  it("says why a file can't be imported", async () => {
    const f = await file("people.csv", "Name,Age\nAnna,4\n");
    await choose([f]);
    assert.match(await toastText(P, /Nothing to import/), /people\.csv: no column of dates found/);
  });

  it("reads spreadsheets: every sheet with dates, and says what it left out", async () => {
    for (const name of ["libreoffice.xlsx", "libreoffice.ods"]) {
      await choose([join(import.meta.dirname, "..", "fixtures", "sheets", name)]);
      assert.deepEqual(
        (await cards()).map((c) => [c.name, c.meta]),
        [
          ["Weight", "3 entries · Nov 2026"],
          ["Steps", "2 entries · Nov 2026"],
          ["Mood", "2 entries · Nov 2026"],
        ],
      );
      assert.deepEqual((await cards())[0].preview, [
        "Nov 2 2026 - 07:30 79,4",
        "Nov 3 2026 - 07:45 79,1",
        "Nov 4 2026 - 20:05 78,9",
      ]);
      await P.click(".ileft summary");
      const left = await P.$$eval(".ileft li", (ls) => ls.map((l) => l.textContent));
      assert.deepEqual(left, [
        `${name} › Notes: no column of dates found`,
        `“Note” in ${name} › Log: text, not numbers`,
      ]);
      await P.click("#sCancel");
    }
  });

  it("says what to do with files it can't read, and reads CSV files in Excel's Windows encoding", async () => {
    const xls = await file("old.xls", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    await choose([xls]);
    assert.match(await toastText(P, /Nothing to import/), /old\.xls: an old Excel file: save it as \.xlsx or CSV/);
    const ansi = await file(
      "vikt.csv",
      Buffer.from("Datum;Vikt\r\n2.11.2026;79,4\r\n13.11.2026;78,8\r\n".replace("Vikt", "Väkt"), "latin1"),
    );
    await choose([ansi]);
    assert.equal((await cards())[0].name, "Väkt");
    await P.click("#sCancel");
  });

  it("logged no errors", () => assert.deepEqual(h.errors, []));
});
