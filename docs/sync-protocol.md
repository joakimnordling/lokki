# Lokki sync protocol, version 1 (draft)

This document describes how Lokki keeps your logs in step between devices through one or more sync servers. It is
written for anyone building or reviewing a client (the web app, a command-line tool) or a server.

Status: **draft for review**. Nothing here is implemented yet.

## Contents

1. [Goals](#1-goals)
2. [Overview](#2-overview)
3. [Records](#3-records)
4. [Keys and encryption](#4-keys-and-encryption)
5. [The server](#5-the-server)
6. [Merging: which version wins](#6-merging-which-version-wins)
7. [Syncing with a server](#7-syncing-with-a-server)
8. [Everyday tasks](#8-everyday-tasks)
9. [Reading clients](#9-reading-clients)
10. [Security](#10-security)
11. [Client status indicators](#11-client-status-indicators)
12. [Test vectors and conformance](#12-test-vectors-and-conformance)
13. [Versioning](#13-versioning)
14. [Later](#14-later)

## 1. Goals

- **Local first.** Every device keeps a complete copy and works offline. Sync is optional; without a server nothing
  leaves the device.
- **End-to-end encrypted, always.** A server stores rows it cannot read. Only devices unlocked with your passphrase
  can read your data.
- **Dumb servers.** All merging happens on devices. A server only stores the latest version of each row and refuses
  writes from devices that aren't up to date.
- **Any number of servers.** Adding the first server works exactly like adding the second. Servers never talk to each
  other; devices carry changes between them.
- **Servers can move.** A server is identified by its own ID, not its URL, so its address can change without setting
  anything up again.

Not in version 1: sharing data between people, several vaults on one device, real-time push (devices poll), and
history of old versions. Section 13 notes how the design leaves room for some of these.

## 2. Overview

```
 device ──pull/push──▶ server A          A device merges everything it pulls with its own copy,
   │                                     then pushes what each server is missing.
   └────pull/push──▶ server B            Servers hold encrypted rows and never see their contents.
```

- Each **record** (a metric or an entry) becomes one **row** on the server: `{key, data}`.
  - `key` is an unreadable name derived from the record's ID, so a newer version of a record replaces the older row.
  - `data` is the record, encrypted.
- Each server keeps a counter per vault. Every row write takes the next number (`seq`), so a device asks "what changed
  since number N?" and gets just that.
- A device may push only when it has already pulled everything up to the server's latest number. Otherwise the server
  answers `409` and the device pulls, merges and tries again. This is like git refusing a push that isn't a
  fast-forward, but there is no history: only the latest version of each row is kept.

## 3. Records

These are the same records the app stores locally and writes to backups, with the same short field names (they keep
payloads small). A record's JSON is what gets encrypted (section 4).

### Entry

| Field    | Type             | Meaning                                                                           |
| -------- | ---------------- | --------------------------------------------------------------------------------- |
| `kind`   | `"entry"`        | Record type                                                                       |
| `id`     | string           | The entry's ID: a random UUID, or a UUIDv5 derived from content for imported data |
| `metric` | string           | ID of the metric it belongs to                                                    |
| `t`      | string or `null` | **Time** it happened: local time without time zone, `YYYY-MM-DDTHH:MM:SS`         |
| `v`      | number or `null` | **Value**                                                                         |
| `n`      | string or `null` | **Note**                                                                          |
| `u`      | integer          | **Updated**: when this record last changed, milliseconds since 1970-01-01 UTC     |
| `d`      | boolean          | **Deleted**. A deleted entry (a _tombstone_) has `t`, `v` and `n` set to `null`   |

```json
{"kind":"entry","id":"6f1c2a90-3b7e-4d1a-9c55-0e8f4b2d7a11","metric":"running","t":"2026-11-08T07:30:00","v":8.4,"n":"easy pace","u":1794120000000,"d":false}
{"kind":"entry","id":"6f1c2a90-3b7e-4d1a-9c55-0e8f4b2d7a11","metric":"running","t":null,"v":null,"n":null,"u":1794123456789,"d":true}
```

### Metric

| Field     | Type             | Meaning                                                                               |
| --------- | ---------------- | ------------------------------------------------------------------------------------- |
| `kind`    | `"metric"`       | Record type                                                                           |
| `id`      | string           | The metric's ID: a random UUID (older metrics have readable slugs)                    |
| `name`    | string or `null` | Name, normalised (Unicode NFC, invisible characters removed, spaces collapsed)        |
| `type`    | string or `null` | Log type, e.g. `"Fitness"`                                                            |
| `created` | string or `null` | When it was created, local time like `t`                                              |
| `u`       | integer          | **Updated**, as for entries                                                           |
| `g`       | integer          | **Generation**: `u` of the deletion this version follows, `0` if never deleted (§6.2) |
| `deleted` | boolean          | Deleted. A deleted metric has `name`, `type` and `created` set to `null`              |

```json
{
  "kind": "metric",
  "id": "running",
  "name": "Running",
  "type": "Fitness",
  "created": "2023-01-01T08:00:00",
  "u": 1794000000000,
  "g": 0,
  "deleted": false
}
```

### Not synced

The chart view of a metric (All Values / Averages / Totals, Daily / Weekly / Monthly) is a per-device setting. It is
never synced. Backups include the backing-up device's view as `mode` and `gran`; restoring sets them only for metrics
that have no view on the restoring device yet.

### Backups

Backups gain the metric field `g`. Backups made before it existed are read as `g: 0`.

## 4. Keys and encryption

### 4.1 The keys

```
passphrase ──Argon2id(salt)──▶ passphrase key ──unwraps──▶ data key (32 random bytes, made once per vault)
                                                               │
                                       HKDF-SHA256 ────────────┤
                                                               ├─ "lokki/v1/encryption" ─▶ encryption key (AES-256-GCM)
                                                               ├─ "lokki/v1/row-names"  ─▶ row-name key (HMAC-SHA256)
                                                               └─ "lokki/v1/keyring-mac" ─▶ keyring key (HMAC-SHA256)
```

- The **data key** is random and never changes. Everything is protected with keys derived from it (HKDF-SHA256, no
  salt, the quoted string as info, 32-byte output).
- A **passphrase** only unlocks the data key, which the vault keyring (4.4) stores _wrapped_ (encrypted with the
  passphrase key). Changing the passphrase re-wraps the data key; no data is re-encrypted.
- Devices keep the three derived keys as non-extractable WebCrypto keys in IndexedDB. They store neither the
  passphrase nor the data key.
- Sign-in to a server (5.2) is separate and has nothing to do with these keys.

### 4.2 Row names: `key`

```
key = base64url( first 16 bytes of HMAC-SHA256(row-name key, kind + ":" + id) )          e.g. "q3Jb0w1sV8ZpK2mXy7c4Ag"
```

- The same record always has the same `key`, so a new version replaces the old row.
- The server can't turn a `key` back into an ID. This matters because imported entries have IDs derived from their
  content.
- 128 bits make accidental collisions practically impossible, and nobody without the row-name key can make one on
  purpose.
- After decrypting a row, a device recomputes the key from the record's `kind` and `id`. A mismatch means the row is
  damaged (7.5).

### 4.3 Row contents: `data`

```
plaintext       = UTF-8 JSON of the record, followed by spaces up to at least 192 bytes, then a multiple of 64 bytes
nonce           = 12 random bytes, new for every encryption
additional data = "lokki/row/v1/" + key
data            = "v1." + base64url( nonce ‖ AES-256-GCM(encryption key, nonce, plaintext, additional data) )
```

- Padding hides the length of values and short notes: at 192 bytes, ordinary entries, metrics and tombstones all look
  the same. Readers ignore trailing spaces, which JSON allows, so writers may pad more (for example randomly) without
  any change to readers.
- The additional data ties the contents to the row and to the format version: a server that swapped rows, or
  relabelled one as another version, makes decryption fail instead of changing your data.

### 4.4 The vault keyring

Each server holds an unencrypted keyring for the vault: what a device needs to unlock the data key, and the vault's
ID. It holds no data. It is the same on every server, and syncs between them with the newest `u` winning:

```json
{
  "format": "lokki-keyring",
  "version": 1,
  "app": "lokki",
  "vault": "Jq9wq3sKp0m2A1xYbXo3Vg",
  "keys": [
    {
      "id": "a7Kq2m",
      "type": "passphrase",
      "created": 1794130000000,
      "kdf": { "name": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "m3P0bXNhbHQtZXhhbXBsZQ" },
      "wrapped": "x7Gk…"
    }
  ],
  "u": 1794130000000,
  "mac": "Hq2v…"
}
```

| Field   | Meaning                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------- |
| `app`   | Which app the vault's data is for: `lokki`. Lowercase letters, digits and `-`, at most 32 characters.     |
| `vault` | Random ID (16 bytes, base64url), made with the data key. A device refuses to mix two different vaults.    |
| `keys`  | The ways to unlock the data key. Version 1 has one of type `passphrase`; a `recovery` key can come later. |
| `u`     | When the keyring last changed                                                                             |
| `mac`   | base64url( HMAC-SHA256(keyring key, canonical JSON of the keyring without `mac`) )                        |

Each entry in `keys`:

| Field     | Meaning                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`      | Short random ID, so an entry can be replaced or removed                                                                |
| `type`    | `passphrase` (or later `recovery`). Devices skip types they don't know.                                                |
| `created` | When the entry was made                                                                                                |
| `kdf`     | Argon2id settings: memory `m` in KiB (64 MiB), iterations `t`, parallelism `p`, 16-byte `salt`; 32-byte output         |
| `wrapped` | base64url( nonce ‖ AES-256-GCM(entry's key, nonce, data key, additional data = `"lokki/key/v1/" + vault + "/" + id`) ) |

- The same servers can hold vaults of other apps that use this protocol, each naming itself in `app`. A device
  refuses a vault of another app, and says so before asking for a passphrase. Servers accept any well-formed `app`.
- A wrong passphrase makes unwrapping fail its integrity check, so the app can say "wrong passphrase" instead of
  showing garbage. Argon2id makes guessing slow.
- The passphrase is normalised to Unicode NFC and encoded as UTF-8 before Argon2id (version 0x13), so the same
  passphrase typed on any device, with composed or decomposed letters like "ä", opens the keyring.
- **Canonical JSON** for the `mac`: object keys sorted, no whitespace, numbers and strings as `JSON.stringify` writes
  them. So that this is the same in every language, a keyring may hold only objects with ASCII keys, arrays, strings,
  `true`, `false`, `null` and integers within ±(2⁵³ − 1); no fractional numbers. Servers refuse anything else
  (`400`), and never convert a value: a changed value would no longer match the `mac`.
- The `mac` stops a server from forging a keyring or reviving an old one (for example to make an old passphrase work
  again): devices with keys check it before accepting a keyring or passing it on, and a new device checks it right
  after unlocking.

## 5. The server

### 5.1 What it stores

| Table  | Contents                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------- |
| server | its random server ID (UUID, made on first start)                                                          |
| vaults | a unique name, `head` (the vault's counter), the vault keyring, the vault ID in it, and `keyring_version` |
| tokens | SHA-256 of each API token, its vault, a label, its scope (`read` or `write`), when it was last used       |
| rows   | the vault, `key`, `seq`, `data`; one row per `key` per vault                                              |

A vault's name and its tokens' labels are for the server's operator: the API never shows them. They're unrelated to
the vault ID in the keyring, which devices make (4.4).

A push writes each row with the next `seq` and replaces any older row with the same `key`. Individual rows are never
removed; deleting a record is a tombstone like any other change. `DELETE /v1/vault` removes a whole vault.

### 5.2 Vaults and sign-in

The server, not the client, issues credentials. Its operator creates a vault, then a token for each device, to enter
in the app together with the server's URL:

```
$ lokki-server vault add jocke
$ lokki-server token add jocke "iPhone 17 Pro"
URL:    https://sync.example.com
Token:  lk_6Yq3kM0p…        (shown only now)
```

- Requests carry `Authorization: Bearer <token>`. The server stores only a hash of the token, so it can't be read
  back. The operator can add tokens to a vault (for example one per device, or a read-only one) and revoke them.
- Tokens have a scope: `write` (the default) or `read`. A `read` token gets `403` for anything but `GET`.
- There is no sign-up through the API.

### 5.3 API

All bodies are JSON. Errors are `{"error": "<code>", "message": "…"}`. Every endpoint except `/v1/info` acts on the
vault that the token belongs to.

| Method and path                    | What it does                                                         |
| ---------------------------------- | -------------------------------------------------------------------- |
| `GET /v1/info`                     | The server's name, version, ID, API versions and limits (no sign-in) |
| `GET /v1/vault`                    | The vault: its keyring and status                                    |
| `DELETE /v1/vault`                 | Deletes the vault, including all its tokens                          |
| `PUT /v1/vault/keyring`            | Replaces the keyring, if up to date                                  |
| `GET /v1/vault/rows?since=&limit=` | Rows changed after a number                                          |
| `POST /v1/vault/rows`              | Adds or replaces rows, if up to date                                 |

#### `GET /v1/info`

```json
{
  "server": "lokki",
  "version": "0.1.0",
  "id": "2c0d4c0e-…",
  "api": [1],
  "limits": { "pull": 1000, "push": 500, "row_bytes": 4096 }
}
```

`id` is how a client recognises a server after its URL changes.

#### `GET /v1/vault`

```json
{
  "keyring": {
    "format": "lokki-keyring",
    "version": 1,
    "app": "lokki",
    "vault": "Jq9wq3sKp0m2A1xYbXo3Vg",
    "keys": ["…"],
    "u": 1794130000000,
    "mac": "Hq2v…"
  },
  "keyring_version": 3,
  "head": 1042,
  "rows": 16977,
  "changed": "2026-11-08T07:31:04Z"
}
```

- `keyring` is the vault keyring (4.4) exactly as last written, or `null` for a new, empty vault. `keyring_version`
  counts its writes (`0` while there is none).
- `head` is the vault's counter, `rows` the number of rows, `changed` when a row or the keyring last changed.

#### `DELETE /v1/vault`

Deletes the vault: its rows, keyring and all its tokens: `204`. Afterwards every device gets `401` from this server
and shows it as no longer accepting the device. Syncing with that server again needs a new vault and token.

#### `PUT /v1/vault/keyring`

Body `{"base": 3, "keyring": {…}}` (`base` is `0` when there is no keyring yet). The keyring must have exactly the
fields of 4.4, with at least one entry in `keys`; anything else is refused with `400`. The server stores it as it is;
it can't check the entries or the `mac`. A new keyring format with other fields will come with a new `version` and
servers that accept it.

- Accepted only if `base` equals `keyring_version`: `200 {"keyring_version": 4}`.
- Otherwise `409 {"error": "behind", "keyring_version": 4}`. The client reads the vault again, keeps the keyring with
  the newer `u`, and tries again if its own was newer.
- A keyring whose `vault` differs from the stored one is refused: `409 {"error": "different_vault"}`.

#### `GET /v1/vault/rows?since=<n>&limit=<k>`

Rows written after number `n`, oldest first.

```json
{
  "rows": [
    { "key": "q3Jb0w1sV8ZpK2mXy7c4Ag", "seq": 1041, "data": "v1.mF3k…" },
    { "key": "Zp81xA0cT2kQ0bVv9eRy4w", "seq": 1042, "data": "v1.Q9aa…" }
  ],
  "cursor": 1042,
  "more": false,
  "head": 1042
}
```

- `limit` is an upper bound (default and maximum: `limits.pull`). The server may return fewer rows for any reason, but
  at least one while `more` is `true`.
- Pass `cursor` as `since` in the next request while `more` is `true`.
- `head` is the vault's current counter. If `since` is greater than `head`, the server has lost changes (7.4).

#### `POST /v1/vault/rows`

```json
{
  "base": 1042,
  "rows": [
    { "key": "q3Jb0w1sV8ZpK2mXy7c4Ag", "data": "v1.n7Yq…" },
    { "key": "Hh0Lr6sPq2uWm8Zt1yBx3Q", "data": "v1.0aPd…" }
  ]
}
```

- Accepted only if `base` equals `head`, all rows in one transaction: `200 {"head": 1044}`.
- Otherwise nothing is written: `409 {"error": "behind", "head": 1050}`.
- At most `limits.push` rows, each `data` at most `limits.row_bytes`, no `key` twice: otherwise `400` or `413`.

#### Other status codes

`401` missing or unknown token, `403` a `read` token trying to write, `429` too many requests (with `Retry-After`),
`5xx` try again later with backoff. A Lokki server's own errors, `5xx` included, are all `{"error", "message"}`; a
`500` is `{"error": "internal", …}` and gives no details. A proxy in front of it may answer `502` or `503` in its own
format, so clients go by the status code.

### 5.4 CORS

The app runs on another origin than the server, so the server answers CORS requests from a configured list of
origins (for example `https://lokki.example.com` and `http://localhost:8080`): methods `GET, POST, PUT, DELETE`,
request headers `Authorization, Content-Type`. No cookies are used, so credentials mode is off.

### 5.5 Test mode

So that one test suite can check any server implementation from the outside, a server started in test mode (and
only then) accepts `POST /v1/test/vaults` without sign-in. It creates an empty vault and returns its name and a token
of each scope: `201 {"name": "test-…", "write": "lk_…", "read": "lk_…"}`. The body may name the vault,
`{"name": "…"}`, or be `{}` for a made-up name; a name in use gives `409 name_taken`. Outside test mode the endpoint
doesn't exist (`404`). A production server must never run in test mode.

## 6. Merging: which version wins

Merging happens only on devices, and every device uses the same rules, so any two devices that have seen the same
versions agree on the result whatever order they saw them in and whichever servers they came from.

### 6.1 Entries

The version with the greater `u` wins. If `u` is equal (two devices in the same millisecond), the greater of
`JSON.stringify([u, d ? 1 : 0, t || "", v ?? "", n || ""])` wins.

### 6.2 Metrics: deletion is final

Deleting a metric must not be undone by an edit that an offline device makes later, even if that edit reaches a
server first. So metrics carry a **generation** `g`:

- A new metric starts with `g = 0`; so does one created by a CSV import.
- Editing a metric keeps its `g`.
- Deleting sets `g = u`: the tombstone starts a new generation.
- Restoring a deleted metric (from a backup, when you choose to bring it back) creates a live version with `g` = the
  tombstone's `u`, and a new `u`.

The winner has the greater `g`; if equal, the live one beats the deleted one; if still equal, the greater `u`. If
all three are equal (two devices in the same millisecond), the greater of
`JSON.stringify([name || "", type || "", created || ""])` wins. (Numbers are compared as numbers here: as text,
`"99"` would sort after `"100"`.)

| Versions compared                                                        | Winner                                       |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| tombstone (`u` 100, `g` 100) vs edit made offline later (`u` 200, `g` 0) | tombstone: higher generation                 |
| tombstone (`g` 100) vs restore (`u` 300, `g` 100)                        | restore: same generation, live beats deleted |
| restore (`g` 100) vs new tombstone (`u` 400, `g` 400)                    | new tombstone                                |

When restoring a backup, a live metric whose `g` is lower than a local tombstone's counts as "deleted since the
backup": it comes back only if you choose "Bring back what you've deleted since", which creates the restore version
above.

### 6.3 Entries of deleted metrics

When a device deletes a metric, it also writes tombstones for all the metric's entries, so their contents disappear
from servers. Entries whose metric is deleted are hidden. A device never pushes a live entry for a metric it knows is
deleted.

## 7. Syncing with a server

### 7.1 What a device remembers

Per server:

| Field             | Meaning                                        |
| ----------------- | ---------------------------------------------- |
| `url`, `token`    | Where and how to sign in                       |
| `id`              | The server's ID from `/v1/info`                |
| `bit`             | This server's bit number on this device (0–31) |
| `cursor`          | Pulled up to this `seq`                        |
| `keyring_version` | Last keyring version seen                      |

Per record: a number whose bits say which servers have the record's current version. Bit `b` is set when server
`b` is known to have exactly this version.

| Event                                                        | Bits                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| The record changes on this device                            | all cleared                                                |
| A pull from server `b` brings the same version               | set bit `b`                                                |
| A pull from server `b` brings a newer version                | the pulled version becomes the local one, only bit `b` set |
| A pull from server `b` brings an older version               | bit `b` stays clear (the local version will be pushed)     |
| A push to server `b` is accepted                             | set bit `b` on the pushed records                          |
| Server `b` is removed, or turns out to be a different server | bit `b` cleared everywhere                                 |

This costs a few bytes per record however many servers there are.

### 7.2 A sync round

1. `GET /v1/info`. If `id` differs from the stored one, this is a different server: clear its bit everywhere and
   start from `cursor` 0.
2. `GET /v1/vault`. Sync the keyring: if the server's has a newer `u` (and a valid `mac`), take it; if this device's
   is newer, or the server has none, write it with `PUT /v1/vault/keyring`.
3. Pull: `GET /v1/vault/rows?since=cursor` until `more` is `false`. Decrypt each row, merge it (section 6) and update
   the bits.
4. Push the records whose bit for this server is clear, in batches, with `base` = the `head` from the pull. On `409`,
   go back to step 3. After each accepted batch, set the bits and move `cursor` to the new `head`.

Rounds run when the app opens, when it comes back to the foreground, a few seconds after a change, and about once a
minute while it is visible. With several servers, a device runs a round with each in turn; a change pulled from one
is pushed to the others because their bits are clear. When a round brought something new, the servers that came
before it get another round right away, so a change crosses from one server to the others in a single sync.

### 7.3 Why "up to date to push" is enough

The server overwrites rows blindly. A push is accepted only from a device that has already pulled everything the
server has, and the device keeps whichever version wins, so what it pushes is never older than what it replaces.
This also makes sure a device that was offline learns about deletions before it can send stale edits.

### 7.4 A server that lost changes

If a pull returns `head` lower than the device's `cursor`, the server was restored from an older state. The device
clears that server's bit everywhere, starts from `cursor` 0, pulls everything and pushes whatever the server lacks.

### 7.5 Rows a device can't read

- **Unknown format** (a `data` prefix other than `v1.`): written by a newer app. The device leaves the row alone,
  never overwrites it, and asks you to update Lokki.
- **Damaged** (a known prefix that fails to decrypt, or a record whose `kind` and `id` don't give the row's `key`):
  - If the key belongs to a local record, the device pushes its own version, repairing the server.
  - Otherwise the device can't repair it and leaves it.
  - Either way it shows a warning naming the server and the number of damaged rows. Repairs are rate-limited, so a
    server that keeps corrupting rows is flagged rather than fought.

## 8. Everyday tasks

| Task                       | What happens                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First device, first server | Choose a passphrase. The app makes the data key and the keyring, and pushes the keyring and all records.                                                             |
| Adding another server      | Enter its URL and token. The app copies the keyring there and pushes all records.                                                                                    |
| Setting up another device  | Enter a server's URL and token, then the passphrase. The app reads the keyring, unlocks the data key, derives the keys and pulls everything.                         |
| Server moved to a new URL  | Edit the URL in the app. The server's `id` is unchanged, so syncing continues where it left off.                                                                     |
| Changing the passphrase    | Enter the old and new passphrase on one device. It replaces the passphrase entry in the keyring and pushes the keyring to its servers; other devices are unaffected. |
| Clearing a device          | Either everything (records, settings, servers and keys) or the records only, keeping servers and keys and downloading everything again.                              |
| Deleting data on a server  | `DELETE /v1/vault` from that server's settings in the app. Other devices see the server as removed.                                                                  |
| Lost every device          | A server's URL and token and the passphrase are all it takes to get everything back.                                                                                 |
| Forgot the passphrase      | The server copies can't be decrypted by anyone. Devices that are still set up keep working; make a backup from one.                                                  |

**Replacing the data key** (if a passphrase and a copy of the keyring may have leaked) means re-encrypting every row on
every server. It is left for a later version.

## 9. Reading clients

A client that only reads, such as a command-line tool that writes a backup or CSV file, needs a server's URL and
token (a `read` token is enough) and the passphrase:

1. `GET /v1/vault`, derive the passphrase key with Argon2id, unwrap the data key from the keyring, derive the keys and
   check the keyring's `mac`.
2. `GET /v1/vault/rows?since=0` until `more` is `false`, and decrypt each row.

A server holds only the latest version of each row, so a reader with one server needs no merging. A server that
hasn't been synced recently may lag behind your devices; a reader that reads several servers merges with the rules in
section 6.

## 10. Security

**A server can see:** how many rows a vault has, their sizes (192 bytes, or more in steps of 64 for long notes and
names), when they change, and the keyring. **It can't see:** names, values, notes, times, IDs, or which rows are
metrics and which are entries. The keyring isn't encrypted, so a server also sees which app a vault is for.

- A server, or anyone who steals its database, can't read the data without the passphrase, and guessing it costs
  Argon2id with 64 MiB of memory per guess. A long passphrase matters.
- A malicious server can withhold or delete rows, or serve old ones, but can't change contents undetected, mix rows
  between records, or forge the keyring. Several servers protect against one losing data.
- API tokens are random, sent only over HTTPS, and stored hashed. HTTPS ends at whatever runs in front of the server
  (a cloud platform, a tunnel or a proxy), so that service can see the token. With it, the service could damage rows
  on that server (7.5), but never read or forge your data.
- Token scopes are enforced by the server alone, so they protect against a leaked `read` token, not against the
  server's operator, who can change a scope or issue tokens. Without the passphrase, writing can only damage or
  delete rows, as above; devices keep their own copies.
- Anyone with an unlocked device can read its data; that is outside what sync can protect.

## 11. Client status indicators

- **Per server:** reachable or not, time of the last successful round, and how many records it lacks (records whose
  bit for it is clear).
- **Overall:** a small indicator in the app's top bar when some local change hasn't reached any server yet.

## 12. Test vectors and conformance

- `protocol/vectors/v1.json` holds fixed inputs and the exact outputs of section 4: derived keys, row keys, padded
  and encrypted rows, Argon2id results, canonical JSON and a keyring. Every client implementation must reproduce
  them; the web app and the Python reference implementation in `protocol/` both do.
- `protocol/conformance/` checks a server over HTTP against sections 5 and 7.3, whatever language it's written in,
  using test mode (5.5).

## 13. Versioning

- The API version is in the path (`/v1/`); `GET /v1/info` lists the versions a server supports.
- The encryption scheme is in each row's `data` prefix (`v1.`), bound into its additional data, and in the keyring's
  `version`.
- Unknown fields in records and keyrings are ignored and kept, so newer clients can add fields.

## 14. Later

Not planned for version 1, but the design leaves room for:

- **A recovery key:** a long random code as a second entry in the keyring's `keys` (type `recovery`), so a forgotten
  passphrase can be replaced.
- **Several vaults on one device,** each with its own keys and servers, and each metric belonging to one vault.
  Servers already keep each vault separately, with its own tokens.
- **Read-only sharing:** a separate vault for what you want to share, plus a `read` token and that vault's passphrase
  for the other person. Anyone with the passphrase can also make valid rows, so this stops them writing only while
  the server enforces the scope; read-only in the cryptography itself would need devices to sign rows.
- **Signed requests** instead of bearer tokens, so services in front of a server never see a usable credential.
  `/v1/info` would list the sign-in methods a server supports.
- **Replacing the data key,** re-encrypting every row.
