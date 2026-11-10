# Lokki protocol: reference implementation, test vectors and conformance tests

- `src/lokki_protocol/` — the encryption of [the sync protocol](../docs/sync-protocol.md) in Python: keys, row names,
  rows and the vault keyring. The web app has its own implementation in JavaScript; both are checked against the
  same test vectors.
- `vectors/v1.json` — fixed inputs and the exact outputs every implementation must produce, written by
  `vectors/generate.py`.
- `conformance/` — tests that check any sync server over HTTP, whatever it's written in.

```sh
uv run pytest tests                     # this implementation against the vectors
uv run python vectors/generate.py       # rewrite the vectors after a deliberate change
uv run pytest conformance               # starts servers/python in test mode and checks it
LOKKI_SERVER_URL=http://localhost:8000 uv run pytest conformance   # check a server that's already running
```
