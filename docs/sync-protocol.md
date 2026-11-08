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
12. [Versioning](#12-versioning)
13. [Open questions](#13-open-questions)

## 1. Goals

- **Local first.** Every device keeps a complete copy and works offline. Sync is optional; without a server nothing
  leaves the device.
- **End-to-end encrypted, always.** A server stores rows it cannot read. Only devices that know your passphrase (or
  have been unlocked with it) can read your data.
- **Dumb servers.** All merging happens on devices. A server only stores the latest version of each row and refuses
  writes from devices that aren't up to date.
- **Any number of servers.** Adding the first server works exactly like adding the second. Servers never talk to each
  other; devices carry changes between them.
- **Servers can move.** A server is identified by its own ID, not its URL, so its address can change without setting
  anything up again.

Not goals for version 1: sharing data between people, real-time push (devices poll), and history of old versions.

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

The chart view of a metric (All Values / Averages / Totals, Daily / Weekly / Monthly) is a per-device setting and is
**not synced**. Backups include the backing-up device's view as `mode` and `gran`.

Backups gain the metric field `g`. Backups made before it existed are read as `g: 0`.

## 4. Keys and encryption

### 4.1 The keys

```
passphrase ──Argon2id(salt)──▶ passphrase key ──unwraps──▶ data key (32 random bytes, made once per vault)
                                                              │
                                     HKDF-SHA256 ─────────────┤
                                                              ├── info "lokki v1 encryption" ─▶ encryption key (AES-256-GCM)
                                                              └── info "lokki v1 row-names"  ─▶ row-name key (HMAC-SHA256)
```

- The **data key** is random and never changes. Everything is encrypted with keys derived from it.
- The **passphrase** you choose only unlocks the data key, which is stored _wrapped_ (encrypted with the passphrase
  key) in the vault header (4.4). Changing the passphrase only re-wraps the data key; no data is re-encrypted.
- Devices keep the derived encryption and row-name keys as non-extractable WebCrypto keys in IndexedDB. They store
  neither the passphrase nor the data key.
- Sign-in to a server (5.2) is separate and has nothing to do with these keys.

### 4.2 Row names: `key`

```
key = base64url( first 16 bytes of HMAC-SHA256(row-name key, kind + ":" + id) )          e.g. "q3Jb0w1sV8ZpK2mXy7c4Ag"
```

The same record always has the same `key`, so a new version replaces the old row. The server can't turn a `key` back
into an ID. This matters because imported entries have IDs derived from their content.

### 4.3 Row contents: `data`

```
plaintext = UTF-8 JSON of the record, followed by spaces up to the next multiple of 64 bytes
nonce     = 12 random bytes, new for every encryption
data      = "v1." + base64url( nonce ‖ AES-256-GCM(encryption key, nonce, plaintext, additional data = UTF-8 of key) )
```

- Padding hides the exact length of notes and values. JSON allows trailing spaces, so the padding needs no removal.
- Using `key` as additional data ties the contents to the row: a server that swapped rows would make decryption fail
  rather than change your data.
- `v1.` names the encryption scheme, so it can change later without changing the API.

### 4.4 The vault header

Each server holds an unencrypted header for the vault. It is the same everywhere, and it syncs like a record, with
the newest `u` winning:

```json
{
  "format": "lokki-vault",
  "version": 1,
  "vault": "Jq9wq3sKp0m2A1xYbXo3Vg",
  "kdf": { "name": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "m3P0bXNhbHQtZXhhbXBsZQ" },
  "wrapped": "x7Gk…",
  "u": 1794000000000
}
```

| Field     | Meaning                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `vault`   | Random ID (16 bytes, base64url) made with the data key. A device refuses to mix two different vaults.             |
| `kdf`     | Argon2id settings: memory `m` in KiB (64 MiB), iterations `t`, parallelism `p`, 16-byte `salt`; 32-byte output    |
| `wrapped` | base64url( nonce ‖ AES-256-GCM(passphrase key, nonce, data key, additional data = `"lokki v1 header " + vault`) ) |
| `u`       | When the header last changed (passphrase changes)                                                                 |

A wrong passphrase makes unwrapping fail its integrity check, so the app can say "wrong passphrase" instead of
showing garbage. The header reveals nothing without the passphrase; Argon2id makes guessing it slow.

## 5. The server

### 5.1 What it stores

| Table    | Contents                                                                                     |
| -------- | -------------------------------------------------------------------------------------------- |
| server   | its random `server` ID (UUID, made on first start)                                           |
| accounts | one per vault: name, `head` (the vault's counter), the vault header and its `header_version` |
| tokens   | SHA-256 of each API token, which account it belongs to, when it was last used                |
| rows     | `account`, `key`, `seq`, `data`; one row per `key` per account                               |

A push writes each row with the next `seq` and replaces any older row with the same `key`. Rows are never removed
through the API; deletion is a tombstone record like any other change.

### 5.2 Accounts and sign-in

The server, not the client, issues credentials. Its operator creates an account and gets an API token to enter in
the app together with the server's URL:

```
$ lokki-server add-account "Home"
URL:   https://sync.example.com
Token: lk_6Yq3kM0p…        (shown once)
```

- Requests carry `Authorization: Bearer <token>`. The server stores only a hash of the token, so it can't be read
  back; the operator can add more tokens to an account (one per device) and revoke them.
- There is no sign-up through the API in version 1.

### 5.3 API

All bodies are JSON. Errors are `{"error": "<code>", "message": "…"}`.

#### `GET /v1/info` (no sign-in)

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

#### `GET /v1/header`

`200 {"header": {…}, "version": 3}`, or `404 {"error": "no_header"}` for a new, empty account.

#### `PUT /v1/header`

Body `{"base": 3, "header": {…}}` (`base` is `null` when there is no header yet). Accepted only if `base` matches the
current `version`: `200 {"version": 4}`. Otherwise `409 {"error": "behind", "version": 4}`; the client fetches the
header, keeps the one with the newer `u`, and tries again if its own was newer. The server refuses a header whose
`vault` differs from the stored one (`409 {"error": "different_vault"}`).

#### `GET /v1/changes?since=<n>&limit=<k>`

Rows written after number `n`, oldest first, at most `k` (default and maximum: `limits.pull`).

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

- Pass `cursor` as `since` in the next request while `more` is `true`.
- `head` is the vault's current counter. If `since` is greater than `head`, the server has lost changes (for example
  it was restored from an older backup); see 7.4.

#### `POST /v1/changes`

```json
{ "base": 1042, "rows": [{ "key": "q3Jb0w1sV8ZpK2mXy7c4Ag", "data": "v1.n7Yq…" }] }
```

- Accepted only if `base` equals `head`, in one transaction: `200 {"head": 1043}`.
- Otherwise nothing is written: `409 {"error": "behind", "head": 1050}`.
- At most `limits.push` rows, each `data` at most `limits.row_bytes`, no `key` twice: else `400`/`413`.

#### Other status codes

`401` missing or unknown token, `429` too many requests (with `Retry-After`), `5xx` try again later with backoff.

### 5.4 CORS

The app runs on another origin than the server, so the server answers CORS requests from a configured list of
origins (for example `https://lokki.example.com` and `http://localhost:8080`): methods `GET, POST, PUT`, request
headers `Authorization, Content-Type`. No cookies are used, so credentials mode is off.

## 6. Merging: which version wins

Merging happens only on devices, and every device uses the same rules, so any two devices that have seen the same
versions agree on the result regardless of order or server.

### 6.1 Entries

The version with the greater `u` wins. If `u` is equal (two devices in the same millisecond), the greater of
`JSON.stringify([u, d ? 1 : 0, t || "", v ?? "", n || ""])` wins.

### 6.2 Metrics: deletion is final

Deleting a metric must not be undone by an edit that an offline device makes later, even if that edit reaches a
server first. So metrics are ordered by their **generation** `g`, then by `u`:

- A deletion sets `g = u` (the tombstone starts a new generation).
- Editing a metric keeps its current `g`.
- Restoring a deleted metric (from a backup, by choice) creates a live version with `g` = the tombstone's `u`.

Order versions by `(g, deleted ? 0 : 1, u)`, then by `JSON.stringify` of the record; the greatest wins.

| Versions compared                                                        | Winner                                       |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| tombstone (`u` 100, `g` 100) vs edit made offline later (`u` 200, `g` 0) | tombstone: higher generation                 |
| tombstone (`g` 100) vs restore (`u` 300, `g` 100)                        | restore: same generation, live beats deleted |
| restore (`g` 100) vs new tombstone (`u` 400, `g` 400)                    | new tombstone                                |

### 6.3 Entries of deleted metrics

When a device deletes a metric, it also writes tombstones for all the metric's entries, so their contents disappear
from servers. Entries whose metric is deleted are hidden. A device never pushes a live entry for a metric it knows is
deleted.

## 7. Syncing with a server

### 7.1 What a device remembers per server

| Field            | Meaning                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `url`, `token`   | Where and how to sign in                                                                       |
| `id`             | The server's ID from `/v1/info`                                                                |
| `cursor`         | Pulled up to this `seq`                                                                        |
| `known`          | For each `key`: the version the server has (its `u`, `g` and tie-break), from pulls and pushes |
| `header_version` | Last header version seen                                                                       |

### 7.2 A sync round

1. `GET /v1/info`. If `id` differs from the stored one, this is a different server: forget `cursor` and `known`.
2. Sync the header (5.3).
3. Pull: `GET /v1/changes?since=cursor` until `more` is `false`. Decrypt each row, merge it (section 6), and record
   it in `known`.
4. Push: the rows whose local version differs from `known` (the server lacks them or has an older one), in batches,
   with `base` = the `head` from the pull. On `409`, go back to step 3. After a successful push, update `known` and
   `cursor`.

Rounds run when the app opens, when it comes back to the foreground, a few seconds after a change, and about once a
minute while it is visible. With several servers, a device runs a round with each in turn; changes pulled from one
are pushed to the others automatically, because the others' `known` lacks them.

### 7.3 Why "up to date to push" is enough

The server overwrites rows blindly. A push is accepted only from a device that has already pulled everything the
server has, and the device keeps whichever version wins, so what it pushes is never older than what it replaces.
This also makes sure a device that was offline learns about deletions before it can send stale edits.

### 7.4 A server that lost changes

If a pull returns `head` lower than the device's `cursor`, the server was restored from an older state. The device
forgets `cursor` and `known` for it and does a full round: it pulls everything and pushes whatever the server lacks.

## 8. Everyday tasks

| Task                       | What happens                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| First device, first server | Choose a passphrase. The app makes the data key and the header, and pushes the header and all records.                                           |
| Adding another server      | Enter its URL and token. The app copies the header there and pushes all records.                                                                 |
| Setting up another device  | Enter a server's URL and token, then the passphrase. The app reads the header, unwraps the data key, derives the keys and pulls everything.      |
| Server moved to a new URL  | Edit the URL in the app. The server's `id` is unchanged, so syncing continues where it left off.                                                 |
| Changing the passphrase    | Enter the old and new passphrase on one device. It re-wraps the data key and pushes the new header to its servers; other devices are unaffected. |
| Lost every device          | A server's URL and token and the passphrase are all it takes to get everything back.                                                             |
| Forgot the passphrase      | The server copies can't be decrypted by anyone. Devices that are still set up keep working; make a backup from one.                              |

**Replacing the data key** (if a passphrase and a copy of the header may have leaked) means re-encrypting every row on
every server. It is left for a later version.

## 9. Reading clients

A client that only reads, such as a command-line tool that writes a backup or CSV file, needs a server's URL and
token and the passphrase:

1. `GET /v1/header`, derive the passphrase key with Argon2id, unwrap the data key, derive the two keys.
2. `GET /v1/changes?since=0` until `more` is `false`, and decrypt each row.

A server holds only the latest version of each row, so a reader with one server needs no merging. A server that
hasn't been synced recently may lag behind your devices; a reader that reads several servers merges with the rules in
section 6.

## 10. Security

**A server can see:** how many rows a vault has, their sizes in steps of 64 bytes, when they change, and the
unencrypted header. **It can't see:** names, values, notes, times, IDs, or which rows are metrics and which are
entries.

- A server (or anyone who steals its database) can't read the data without the passphrase, and guessing it is slowed
  by Argon2id with 64 MiB of memory per guess. A long passphrase matters.
- A malicious server can withhold or delete rows, or serve old ones (denial of service), but can't change contents
  undetected or mix rows between records. Several servers protect against one losing data.
- API tokens are random, sent only over HTTPS, and stored hashed on the server.
- Anyone with an unlocked device can read its data; that is outside what sync can protect.

## 11. Client status indicators

- **Per server:** reachable or not, time of the last successful round, and how many local records it lacks (records
  whose version differs from `known`).
- **Overall:** a small indicator in the header when some local change has not reached any server yet.

## 12. Versioning

- The API version is in the path (`/v1/`); `GET /v1/info` lists the versions a server supports.
- The encryption scheme is in each row's `data` prefix (`v1.`) and the header's `version`.
- Unknown fields in records and headers are ignored and kept, so newer clients can add fields.

## 13. Open questions

- Clearing all data on one device while sync is set up: should it only clear the device (and pull everything again),
  or offer to delete the vault on the servers too?
- Whether pulls should be limited per request by size as well as by count.
- A recovery code as a second way to unwrap the data key.
