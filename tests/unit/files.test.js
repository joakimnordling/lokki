import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBackup } from "../../src/core/backup-format.js";
import { crc32, unzipFirst, zipOne } from "../../src/core/zip.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

describe("zip", () => {
  it("computes the standard CRC-32", () => {
    assert.equal(crc32(enc("123456789")), 0xcbf43926);
  });
  it("round-trips a file and refuses a damaged one", async () => {
    const text = '{"kind":"header"}\n'.repeat(500);
    const zip = new Uint8Array(await (await zipOne("x.jsonl", enc(text))).arrayBuffer());
    assert.ok(zip.length < text.length / 5, "compressed");
    assert.equal(dec(await unzipFirst(zip)), text);
    const broken = zip.slice();
    broken[40] ^= 0xff;
    await assert.rejects(unzipFirst(broken));
    await assert.rejects(unzipFirst(zip.subarray(0, 100)));
  });
});

describe("backup format", () => {
  const header =
    '{"kind":"header","format":"lokki","version":1,"exported":"2026-11-07T10:00:00.000Z","app":"lokki-web"}';
  const metric =
    '{"kind":"metric","id":"running","name":"Running","type":"Fitness","mode":null,"gran":null,"created":null,"u":1,"deleted":false}';
  const entry =
    '{"kind":"entry","id":"e1","metric":"running","t":"2026-01-15T07:30:00","v":2.5,"n":null,"u":2,"d":false}';
  const gone = '{"kind":"entry","id":"e2","metric":"running","t":null,"v":null,"n":null,"u":3,"d":true}';
  const footer = '{"kind":"footer"}';
  const file = (...lines) => `${lines.join("\n")}\n`;

  it("reads metrics and entries, skipping unknown kinds", () => {
    const b = parseBackup(file(header, '{"kind":"settings","x":1}', metric, entry, gone, footer));
    assert.equal(b.error, undefined);
    assert.deepEqual([...b.metrics.keys()], ["running"]);
    assert.deepEqual([...b.entries.keys()], ["e1", "e2"]);
  });
  it("refuses files that aren't complete Lokki backups", () => {
    assert.match(parseBackup(file(metric, footer)).error, /isn't a Lokki backup/);
    assert.match(parseBackup(file(header, metric, entry)).error, /incomplete/);
    assert.match(parseBackup(file(header.replace('"version":1', '"version":2'), footer)).error, /newer version/);
  });
  it("points at the invalid line", () => {
    const bad = '{"kind":"entry","id":"x","metric":"running"}';
    assert.match(parseBackup(file(header, metric, bad, footer)).error, /^Line 3 isn't a valid entry/);
    assert.match(parseBackup(file(header, "not json", footer)).error, /^Line 2 isn't a valid line/);
    assert.match(parseBackup(file(header, footer, footer)).error, /^Line 2 isn't a valid line here/);
  });
});
