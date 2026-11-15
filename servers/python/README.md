# Lokki sync server (Python)

The reference sync server for [Lokki](../../README.md): it stores end-to-end encrypted rows for any number of
devices, as described in [the sync protocol](../../docs/sync-protocol.md). It can't read anything it stores.

FastAPI on Python 3.15. It stores in SQLite, PostgreSQL or Google Cloud Firestore, chosen by `LOKKI_DATABASE_URL`:

| Storage    | `LOKKI_DATABASE_URL`                                                                                      | Install                    |
| ---------- | --------------------------------------------------------------------------------------------------------- | -------------------------- |
| SQLite     | `sqlite+aiosqlite:///lokki.db` (the default)                                                              | `lokki-server`             |
| PostgreSQL | `postgresql://user:password@host/database`, or as a service gives it, e.g. `postgres://…?sslmode=require` | `lokki-server[postgresql]` |
| Firestore  | `firestore://PROJECT[/DATABASE]`; collections are named `lokki_…` unless `?prefix=` says otherwise        | `lokki-server[firestore]`  |

The container image ([Dockerfile](Dockerfile)) has all three. [docs/deploy-cloud-run.md](../../docs/deploy-cloud-run.md)
describes running it on Google Cloud Run.

## Running it

Requires [uv](https://docs.astral.sh/uv/).

```sh
uv run lokki-server vault add jocke                    # a vault: one person's logs
uv run lokki-server token add jocke "iPhone 17 Pro"    # prints the URL and a token to enter in the app
uv run lokki-server token add jocke browser            # one token per device
uv run lokki-server token add jocke iPad --qr          # also a QR code to scan in the app
uv run lokki-server serve                              # http://127.0.0.1:8000, data in ./lokki.db
```

`serve` updates the database's tables first; `serve --reload` also restarts it when the code changes, for
development. The other commands:

| Command                             | What it does                                              |
| ----------------------------------- | --------------------------------------------------------- |
| `vault list`                        | The vaults, with how many rows and tokens each has        |
| `vault delete NAME`                 | Deletes a vault with everything in it and its tokens      |
| `token add VAULT LABEL [--scope …]` | A new token; `--scope read` for one that can only read    |
| `token add VAULT LABEL --qr`        | Also prints a QR code: Sync → Scan QR Code in the app     |
| `… --qr --app NAME`                 | The QR code for another app on the protocol (not Lokki)   |
| `token list VAULT`                  | The vault's tokens and when each was last used            |
| `token revoke VAULT LABEL`          | The device using that token can no longer sync            |
| `migrate`                           | Updates the database's tables without starting the server |

Vault names are case-sensitive, 1 to 64 letters, digits and `. _ + - @`, starting with a letter or digit. A token's
label can be any text up to 100 characters, unique within its vault, such as the device's name. Names and labels stay
on the server: the API never shows them. Add `--help` to any command for more.

## Settings

Environment variables, or a `.env` file in the working directory:

| Variable                   | Default                        | Meaning                                                                         |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| `LOKKI_DATABASE_URL`       | `sqlite+aiosqlite:///lokki.db` | Where to store: see the table above                                             |
| `LOKKI_PUBLIC_URL`         | `http://localhost:8000`        | The URL devices use; printed with new tokens                                    |
| `LOKKI_CORS_ORIGINS`       | `[]`                           | Where the web app is served from, as JSON: `["https://lokki.example.com"]`      |
| `LOKKI_LIMITS__PULL`       | `1000`                         | Most rows in one pull                                                           |
| `LOKKI_LIMITS__PUSH`       | `500`                          | Most rows in one push                                                           |
| `LOKKI_LIMITS__ROW_BYTES`  | `4096`                         | Largest row                                                                     |
| `LOKKI_HISTORY`            | `1000`                         | Pushes per vault whose marks are kept; devices away longer pull everything once |
| `LOKKI_POOL__SIZE`         | `3`                            | PostgreSQL: connections kept open                                               |
| `LOKKI_POOL__MAX_OVERFLOW` | `2`                            | PostgreSQL: extra connections when all are busy                                 |
| `LOKKI_POOL__RECYCLE`      | `1800`                         | PostgreSQL: seconds before a connection is replaced                             |
| `LOKKI_DOCS`               | `true`                         | API docs: Swagger UI at `/docs`, ReDoc at `/redoc`                              |
| `LOKKI_TEST_MODE`          | `false`                        | Enables `POST /v1/test/vaults` for the conformance tests. Never in production.  |
| `PORT`                     | `8000`                         | Port for `serve`                                                                |

## API docs

The running server documents its API: Swagger UI at `/docs` (choose **Authorize** and paste a token to try the
endpoints) and ReDoc at `/redoc`, both from `/openapi.json`. The protocol itself is in
[docs/sync-protocol.md](../../docs/sync-protocol.md). The server serves the pages' scripts and styles itself
([fastapi-standalone-docs](https://github.com/ioxiocom/fastapi-standalone-docs)), so they load nothing from other
sites. Set `LOKKI_DOCS=false` to turn them off.

## Development

```sh
uv sync
uv run pytest            # tests, with snapshots in tests/__snapshots__ (update with --snapshot-update)
uv run pytest --cov      # also coverage; CI requires 100% of lines and branches, on every storage
uv run ruff check && uv run ruff format --check
uv run pyright
```

The tests run on SQLite, and also on the other storages when they're available, as in CI:

```sh
# PostgreSQL: a server to make a database on for each test
LOKKI_TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres uv run pytest
# Firestore: Google's emulator (needs Java 21 or newer)
gcloud emulators firestore start --host-port=127.0.0.1:8086 &
FIRESTORE_EMULATOR_HOST=127.0.0.1:8086 uv run pytest
```
