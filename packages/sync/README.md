# lokki-sync

The [Lokki sync protocol](../../docs/sync-protocol.md) in JavaScript, for any app that wants end-to-end encrypted sync
through a Lokki sync server (`servers/python`). Lokki itself uses it; another app can too, with its own name, kinds of
records and merge rule. Plain ES modules for browsers (WebCrypto, `fetch`); the only dependency is `hash-wasm`, for
Argon2id.

| Module       | What it has                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `crypto.js`  | Keys, row names, row encryption and the vault keyring (spec section 4)                               |
| `engine.js`  | One sync round with a server, and `syncAll` for several (section 7)                                  |
| `http.js`    | `ServerClient`, the server's API (section 5)                                                         |
| `manager.js` | `createSyncManager`: a browser app's vault, servers and when to sync, over a key-value store         |
| `memory.js`  | `MemoryDevice`, a device that keeps everything in memory: the reference adapter, for tests and tools |
| `pairing.js` | The text in a pairing QR code, as `lokki-server token add … --qr` prints it                          |
| `b64.js`     | base64url and hex                                                                                    |

## An app's settings

```js
const APP = {
  name: "other-app", // in every key label and bound text, the keyring's `app` and pairing codes
  kinds: ["note"], // the kinds of records it syncs; a row with any other kind counts as damaged
  compare: (a, b) => a.u - b.u, // which version of a record wins: positive a, negative b, 0 the same
};
```

The name is lowercase letters, digits and dashes, at most 32. It keeps apps apart: the same data key gives each app
its own keys and row names, a device refuses a server whose keyring is for another app, and each app takes only
pairing codes that start with its own name (`other-app:sync?url=…&token=…`, from `token add … --qr --app other-app`).
Lokki's settings are in `src/sync/app.js`.

`compare` must give the same answer on every device whatever order versions arrive in. Records are JSON objects with
`kind` and `id`; everything else in them is the app's.

## Using it

The engine works through a _device_, an adapter over wherever the app keeps its records; `engine.js` lists what it
needs and `memory.js` is the reference one.

```js
import { deriveKeys, newKeyring } from "lokki-sync/crypto.js";
import { syncAll } from "lokki-sync/engine.js";
import { ServerClient } from "lokki-sync/http.js";
import { MemoryDevice } from "lokki-sync/memory.js";

const { keyring, dataKey } = await newKeyring(passphrase, { app: APP.name, now: Date.now() });
const device = new MemoryDevice({ compare: APP.compare });
device.setKeyring(keyring);
const links = [{ server: { url, token, bit: 0, cursor: 0 }, http: new ServerClient(url, token) }];
const results = await syncAll({ app: APP, device, keys: await deriveKeys(dataKey, APP.name), links });
```

A browser app would rather use `createSyncManager` (see `manager.js` and Lokki's `src/sync/manager.js`), which keeps the
keyring, the non-extractable keys and each server's state in the app's store.

## Installing

It isn't published. Another repository can install it from this one at a commit, e.g. with pnpm:

```sh
pnpm add "github:joakimnordling/lokki#<commit>&path:/packages/sync"
```

or copy the folder and note the commit it came from. The test vectors (`protocol/vectors/v1.json`) include a set for
an app called `other-app`; the tests are in this repository's `tests/unit` and `tests/sync`.
