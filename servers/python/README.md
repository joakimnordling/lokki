# Lokki sync server (Python)

The reference sync server for [Lokki](../../README.md): it stores end-to-end encrypted rows for any number of
devices, as described in [the sync protocol](../../docs/sync-protocol.md). It can't read anything it stores.

FastAPI on Python 3.15. Storage is SQL through SQLAlchemy (SQLite now; PostgreSQL, MariaDB and Firestore planned).

## Running it

Requires [uv](https://docs.astral.sh/uv/).

```sh
uv run lokki-server add-account "Home"     # prints the URL and a token to enter in the app
uv run lokki-server serve                  # http://127.0.0.1:8000, data in ./lokki.db
```

`serve` updates the database's tables first. Other commands: `accounts`, `tokens ACCOUNT`, `add-token ACCOUNT`,
`revoke TOKEN`, `delete-account ACCOUNT`, `migrate`. Add `--help` to any of them.

## Settings

Environment variables, or a `.env` file in the working directory:

| Variable                  | Default                        | Meaning                                                                          |
| ------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| `LOKKI_DATABASE_URL`      | `sqlite+aiosqlite:///lokki.db` | SQLAlchemy URL with an async driver                                              |
| `LOKKI_PUBLIC_URL`        | `http://localhost:8000`        | The URL devices use; printed with new tokens                                     |
| `LOKKI_CORS_ORIGINS`      | `[]`                           | Where the web app is served from, as JSON: `["https://lokki.example.com"]`       |
| `LOKKI_LIMITS__PULL`      | `1000`                         | Most rows in one pull                                                            |
| `LOKKI_LIMITS__PUSH`      | `500`                          | Most rows in one push                                                            |
| `LOKKI_LIMITS__ROW_BYTES` | `4096`                         | Largest row                                                                      |
| `LOKKI_TEST_MODE`         | `false`                        | Enables `POST /v1/test/accounts` for the conformance tests. Never in production. |
| `PORT`                    | `8000`                         | Port for `serve`                                                                 |

## Development

```sh
uv sync
uv run pytest            # tests, with snapshots in tests/__snapshots__ (update with --snapshot-update)
uv run ruff check && uv run ruff format --check
uv run pyright
```
