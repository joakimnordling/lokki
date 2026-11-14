/* The encryption of the sync protocol (docs/sync-protocol.md, section 4), with WebCrypto and Argon2id from hash-wasm.
   Every function that makes random values accepts them as options, which is how the test vectors are reproduced.

   `app` is the app's name (lowercase letters, digits and hyphens, at most 32): it's the keyring's `app`, and it starts
   every label and every text bound into the encryption, so each app's keys and rows are its own. Lokki's is "lokki". */
import { argon2id } from "hash-wasm";
import { fromB64url, toB64url } from "./b64.js";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export const ROW_VERSION = "v1";
/**
 * The newest row format this code can decrypt and parse (v1). When a release can decrypt and parse a newer one,
 * devices pull everything again.
 */
export const READABLE_ROW_FORMAT = 1;
const MIN_PADDED = 192;
const PAD_STEP = 64;
export const DEFAULT_KDF = { name: "argon2id", m: 65536, t: 3, p: 1 };

/** A row written by a newer app, in a format this one doesn't know (section 7.5). */
export class FormatError extends Error {}
/** A row that doesn't decrypt, or whose record doesn't belong to its key (section 7.5). */
export class DamagedRowError extends Error {}
/** No entry in the keyring opens with this passphrase. */
export class WrongPassphraseError extends Error {}
/** A keyring whose mac doesn't match: changed by someone without the data key. */
export class DamagedKeyringError extends Error {}

const APP_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The app's name, checked: every function that needs one gets it explicitly, so no app falls back to another's. */
export function appName(app) {
  if (typeof app !== "string" || !APP_NAME.test(app)) throw new TypeError(`not an app name: ${app}`);
  return app;
}

const hkdf = async (base, info, algorithm, usages) =>
  subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
    base,
    algorithm,
    false,
    usages,
  );

/** The three keys derived from a data key (section 4.1), as non-extractable CryptoKeys. */
export async function deriveKeys(dataKey, app) {
  appName(app);
  const base = await subtle.importKey("raw", dataKey, "HKDF", false, ["deriveKey"]);
  const hmac = { name: "HMAC", hash: "SHA-256", length: 256 };
  const [encryption, rowNames, keyringMac] = await Promise.all([
    hkdf(base, `${app}/v1/encryption`, { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
    hkdf(base, `${app}/v1/row-names`, hmac, ["sign"]),
    hkdf(base, `${app}/v1/keyring-mac`, hmac, ["sign", "verify"]),
  ]);
  return { encryption, rowNames, keyringMac };
}

const sign = async (key, text) => new Uint8Array(await subtle.sign("HMAC", key, enc.encode(text)));

/** A record's row name: the first 16 bytes of HMAC-SHA256 over "kind:id" (section 4.2). */
export async function rowKey(keys, kind, id) {
  // A record's row name never changes for the same keys, so each is computed once: pushing many records, skipping
  // held ones batch after batch, and finding damaged rows' records then cost a lookup. About 80 bytes per record.
  let names = rowNameCache.get(keys);
  if (!names) {
    names = new Map();
    rowNameCache.set(keys, names);
  }
  const name = `${kind}:${id}`;
  let key = names.get(name);
  if (key === undefined) {
    key = toB64url((await sign(keys.rowNames, name)).subarray(0, 16));
    names.set(name, key);
  }
  return key;
}
const rowNameCache = new WeakMap(); // the keys -> "kind:id" -> row name; gone with the keys (another vault, cleared)

/** UTF-8, then spaces up to at least 192 bytes and a multiple of 64 (section 4.3). */
export function pad(text) {
  const data = enc.encode(text);
  const size = Math.max(MIN_PADDED, Math.ceil(data.length / PAD_STEP) * PAD_STEP);
  const out = new Uint8Array(size).fill(0x20);
  out.set(data);
  return out;
}

const rowAad = (app, key) => enc.encode(`${appName(app)}/row/${ROW_VERSION}/${key}`);

/** A record as a row: {key, data}. */
export async function encryptRow(keys, record, { app, nonce = random(12) } = {}) {
  const key = await rowKey(keys, record.kind, record.id);
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: rowAad(app, key) },
      keys.encryption,
      pad(JSON.stringify(record)),
    ),
  );
  const both = new Uint8Array(12 + sealed.length);
  both.set(nonce);
  both.set(sealed, 12);
  return { key, data: `${ROW_VERSION}.${toB64url(both)}` };
}

/**
 * The record in a row. Throws FormatError or DamagedRowError. `kinds`: the kinds of record the app has; a row holding
 * any other counts as damaged.
 */
export async function decryptRow(keys, key, data, { app, kinds }) {
  const aad = rowAad(app, key);
  const dot = data.indexOf(".");
  if (dot < 0 || data.slice(0, dot) !== ROW_VERSION) throw new FormatError(`unknown row format ${data.slice(0, dot)}`);
  let record;
  try {
    const raw = fromB64url(data.slice(dot + 1));
    if (raw.length < 12 + 16) throw new Error("too short");
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: aad },
      keys.encryption,
      raw.subarray(12),
    );
    record = JSON.parse(dec.decode(plain));
  } catch (e) {
    throw new DamagedRowError(e.message || "doesn't decrypt");
  }
  if (!record || typeof record !== "object" || !kinds.includes(record.kind) || typeof record.id !== "string")
    throw new DamagedRowError("not a record");
  if ((await rowKey(keys, record.kind, record.id)) !== key)
    throw new DamagedRowError("the record doesn't belong to this key");
  return record;
}

/** Sorted keys, no whitespace: what the keyring's mac is computed over (section 4.4). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Argon2id (version 0x13) of the passphrase, after Unicode NFC, with an entry's settings: 32 bytes. */
export async function passphraseKey(passphrase, kdf) {
  if (kdf.name !== "argon2id") throw new Error(`unknown key derivation ${kdf.name}`);
  return argon2id({
    password: enc.encode(passphrase.normalize("NFC")),
    salt: fromB64url(kdf.salt),
    iterations: kdf.t,
    memorySize: kdf.m,
    parallelism: kdf.p,
    hashLength: 32,
    outputType: "binary",
  });
}

const keyAad = (app, vault, entryId) => enc.encode(`${appName(app)}/key/v1/${vault}/${entryId}`);
const withoutMac = ({ mac: _, ...rest }) => rest;

/** HMAC-SHA256 over the canonical JSON of the keyring without its mac. */
export async function keyringMac(keys, keyring) {
  return toB64url(await sign(keys.keyringMac, canonicalJson(withoutMac(keyring))));
}

/** Whether a keyring's mac is right for these keys (constant-time comparison by WebCrypto). */
export async function verifyKeyring(keys, keyring) {
  try {
    return await subtle.verify(
      "HMAC",
      keys.keyringMac,
      fromB64url(keyring.mac || ""),
      enc.encode(canonicalJson(withoutMac(keyring))),
    );
  } catch {
    return false;
  }
}

/** A keys entry that opens the data key with a passphrase. */
export async function passphraseEntry(
  dataKey,
  vault,
  passphrase,
  { app, now, entryId, salt, nonce, kdf = DEFAULT_KDF } = {},
) {
  const id = entryId ?? toB64url(random(6));
  const settings = { ...kdf, salt: toB64url(salt ?? random(16)) };
  const iv = nonce ?? random(12);
  const wrappingKey = await subtle.importKey("raw", await passphraseKey(passphrase, settings), "AES-GCM", false, [
    "encrypt",
  ]);
  const sealed = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv, additionalData: keyAad(app, vault, id) }, wrappingKey, dataKey),
  );
  const both = new Uint8Array(12 + sealed.length);
  both.set(iv);
  both.set(sealed, 12);
  return { id, type: "passphrase", created: now, kdf: settings, wrapped: toB64url(both) };
}

/**
 * A complete keyring with its mac. `format: "lokki-keyring"` names the protocol's keyring layout, the same for every
 * app; `app` says whose it is.
 */
export async function sealKeyring(keys, vault, entries, u, app) {
  const keyring = { format: "lokki-keyring", version: 1, app: appName(app), vault, keys: entries, u };
  keyring.mac = await keyringMac(keys, keyring);
  return keyring;
}

/** A new vault: {keyring, dataKey}. */
export async function newKeyring(
  passphrase,
  { app, now, dataKey = random(32), vault = toB64url(random(16)), ...entry } = {},
) {
  const first = await passphraseEntry(dataKey, vault, passphrase, { app, now, ...entry });
  return { keyring: await sealKeyring(await deriveKeys(dataKey, app), vault, [first], now, app), dataKey };
}

/** The data key, if the passphrase opens an entry and the keyring's mac is right (with this app's labels). */
export async function unlock(keyring, passphrase, app) {
  appName(app);
  for (const entry of keyring.keys || []) {
    if (entry.type !== "passphrase") continue;
    let dataKey;
    try {
      const raw = fromB64url(entry.wrapped);
      const wrappingKey = await subtle.importKey("raw", await passphraseKey(passphrase, entry.kdf), "AES-GCM", false, [
        "decrypt",
      ]);
      dataKey = new Uint8Array(
        await subtle.decrypt(
          { name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: keyAad(app, keyring.vault, entry.id) },
          wrappingKey,
          raw.subarray(12),
        ),
      );
    } catch {
      continue;
    }
    if (!(await verifyKeyring(await deriveKeys(dataKey, app), keyring)))
      throw new DamagedKeyringError("the keyring's mac doesn't match");
    return dataKey;
  }
  throw new WrongPassphraseError("no entry opens with this passphrase");
}

/** The keyring with its passphrase entry replaced (other entries kept), with a newer u. */
export async function changePassphrase(keyring, dataKey, passphrase, { app, now, ...entry } = {}) {
  const others = keyring.keys.filter((e) => e.type !== "passphrase");
  const fresh = await passphraseEntry(dataKey, keyring.vault, passphrase, { app, now, ...entry });
  return sealKeyring(
    await deriveKeys(dataKey, app),
    keyring.vault,
    [fresh, ...others],
    Math.max(now, keyring.u + 1),
    app,
  );
}
