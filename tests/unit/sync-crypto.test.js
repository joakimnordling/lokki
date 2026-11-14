// The app's encryption against the shared test vectors (protocol/vectors/v1.json), which the Python reference
// implementation also passes: both must produce exactly the same bytes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fromB64url, fromHex, toB64url, toHex } from "../../src/sync/b64.js";
import {
  canonicalJson,
  changePassphrase,
  DamagedKeyringError,
  DamagedRowError,
  decryptRow,
  deriveKeys,
  encryptRow,
  FormatError,
  keyringMac,
  newKeyring,
  pad,
  passphraseKey,
  rowKey,
  unlock,
  verifyKeyring,
  WrongPassphraseError,
} from "../../src/sync/crypto.js";

const V = JSON.parse(readFileSync(new URL("../../protocol/vectors/v1.json", import.meta.url), "utf8"));
const keys = await deriveKeys(fromHex(V.data_key));
const SMALL = { name: "argon2id", m: 64, t: 1, p: 1 };

describe("test vectors", () => {
  it("derives the same row keys", async () => {
    for (const r of V.row_keys) assert.equal(await rowKey(keys, r.kind, r.id), r.key);
  });
  it("remembers row keys per set of keys, each computed once", async () => {
    const fresh = await deriveKeys(fromHex(V.data_key)); // the same vault's keys, as after unlocking again
    let signed = 0;
    const counting = { ...fresh, rowNames: fresh.rowNames };
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    crypto.subtle.sign = (...args) => {
      signed++;
      return sign(...args);
    };
    try {
      const r = V.row_keys[0];
      assert.equal(await rowKey(counting, r.kind, r.id), r.key);
      assert.equal(await rowKey(counting, r.kind, r.id), r.key);
      assert.equal(signed, 1, "the second time is a lookup");
      const other = await deriveKeys(new Uint8Array(32).fill(7)); // another vault: its own names
      assert.notEqual(await rowKey(other, r.kind, r.id), r.key);
    } finally {
      crypto.subtle.sign = sign;
    }
  });
  it("encrypts records into exactly the same rows", async () => {
    for (const row of V.rows) {
      assert.equal(JSON.stringify(row.record), row.plaintext);
      assert.equal(pad(row.plaintext).length, row.padded_length);
      assert.deepEqual(await encryptRow(keys, row.record, { nonce: fromHex(row.nonce) }), {
        key: row.key,
        data: row.data,
      });
      assert.deepEqual(await decryptRow(keys, row.key, row.data), row.record);
    }
  });
  it("derives the same Argon2id keys, after Unicode NFC", async () => {
    for (const a of V.argon2id) assert.equal(toHex(await passphraseKey(a.passphrase, a.kdf)), a.output);
  });
  it("writes the same canonical JSON", () => {
    for (const c of V.canonical_json) assert.equal(canonicalJson(c.value), c.json);
  });
  it("makes the same keyring, and unlocks it", async () => {
    const { inputs, keyring, passphrase } = V.keyring;
    const made = await newKeyring(passphrase, {
      now: inputs.now,
      dataKey: fromHex(V.data_key),
      vault: inputs.vault,
      entryId: inputs.entry_id,
      salt: fromHex(inputs.salt),
      nonce: fromHex(inputs.nonce),
    });
    assert.deepEqual(made.keyring, keyring);
    assert.equal(toHex(await unlock(keyring, passphrase)), V.data_key);
    assert.ok(await verifyKeyring(keys, keyring));
  });
});

describe("rows", () => {
  const row = V.rows[0];
  it("pads to at least 192 bytes, then in steps of 64", () => {
    assert.deepEqual(
      [1, 192, 193, 256, 257].map((n) => pad("x".repeat(n)).length),
      [192, 192, 256, 256, 320],
    );
    assert.equal(pad("ä".repeat(100)).length, 256);
  });
  it("uses a new nonce every time", async () => {
    assert.notEqual((await encryptRow(keys, row.record)).data, (await encryptRow(keys, row.record)).data);
  });
  it("tells unknown formats from damage", async () => {
    await assert.rejects(decryptRow(keys, row.key, `v2.${row.data.slice(3)}`), FormatError);
    await assert.rejects(decryptRow(keys, row.key, "garbage"), FormatError);
    await assert.rejects(decryptRow(keys, row.key, `${row.data.slice(0, -4)}AAAA`), DamagedRowError);
    await assert.rejects(decryptRow(keys, V.rows[2].key, row.data), DamagedRowError);
    await assert.rejects(decryptRow(keys, row.key, "v1.AAAA"), DamagedRowError);
    await assert.rejects(decryptRow(keys, row.key, "v1.not*base64"), DamagedRowError);
  });
  it("refuses a record that doesn't belong to its key", async () => {
    const other = await encryptRow(keys, { ...row.record, id: "someone-else" });
    await assert.rejects(decryptRow(keys, row.key, other.data), DamagedRowError);
  });
});

describe("keyring", () => {
  it("refuses a wrong passphrase and a changed keyring", async () => {
    const { keyring, passphrase } = V.keyring;
    await assert.rejects(unlock(keyring, "wrong"), WrongPassphraseError);
    await assert.rejects(unlock({ ...keyring, u: keyring.u + 1 }, passphrase), DamagedKeyringError);
    assert.equal(await verifyKeyring(keys, { ...keyring, u: 1 }), false);
    assert.equal(await verifyKeyring(keys, { ...keyring, mac: "%%" }), false);
  });
  it("changes the passphrase, keeping the data key and other entries", async () => {
    const { keyring, dataKey } = await newKeyring("first passphrase", { now: 1000, kdf: SMALL });
    const future = { id: "r1", type: "recovery", created: 1, kdf: {}, wrapped: "x" };
    const changed = await changePassphrase(
      { ...keyring, keys: [future, ...keyring.keys] },
      dataKey,
      "second passphrase",
      {
        now: 500,
        kdf: SMALL,
      },
    );
    assert.equal(changed.u, 1001);
    assert.deepEqual(
      changed.keys.map((e) => e.type),
      ["passphrase", "recovery"],
    );
    assert.deepEqual(await unlock(changed, "second passphrase"), dataKey);
    await assert.rejects(unlock(changed, "first passphrase"), WrongPassphraseError);
    assert.equal(changed.mac, await keyringMac(await deriveKeys(dataKey), changed));
  });
});

describe("base64url", () => {
  it("round-trips and refuses the standard alphabet", () => {
    assert.equal(toB64url(Uint8Array.of(0xfb, 0xff)), "-_8");
    assert.deepEqual(fromB64url("-_8="), Uint8Array.of(0xfb, 0xff));
    assert.throws(() => fromB64url("+/8"));
  });
});
