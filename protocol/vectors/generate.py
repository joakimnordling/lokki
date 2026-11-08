"""
Write ``v1.json``: fixed inputs and the outputs every implementation must reproduce exactly.

Run from ``protocol/``: ``uv run python vectors/generate.py``. ``tests/test_vectors.py`` fails if
the file and this script disagree, and the web app's unit tests check its own implementation
against the file.
"""

import json
from pathlib import Path
from typing import Any

from lokki_protocol.crypto import (
    canonical_json,
    derive_keys,
    encrypt_row,
    new_keyring,
    pad,
    passphrase_key,
    record_json,
    row_key,
)

OUT = Path(__file__).with_name("v1.json")


def fixed(n: int, length: int) -> bytes:
    """Fixed bytes standing in for random ones: n, n+1, n+2, ..."""
    return bytes((n + i) % 256 for i in range(length))


DATA_KEY = fixed(1, 32)
PASSPHRASE = "correct horse battery staple"
UUID = "6f1c2a90-3b7e-4d1a-9c55-0e8f4b2d7a11"

RECORDS: list[dict[str, Any]] = [
    {
        "kind": "entry",
        "id": UUID,
        "metric": "running",
        "t": "2026-11-08T07:30:00",
        "v": 8.4,
        "n": None,
        "u": 1794120000000,
        "d": False,
    },
    {
        "kind": "entry",
        "id": UUID,
        "metric": "running",
        "t": None,
        "v": None,
        "n": None,
        "u": 1794123456789,
        "d": True,
    },
    {
        "kind": "entry",
        "id": "b40e5589-5bc6-581c-8137-d78c1803269f",
        "metric": "reading",
        "t": "2026-01-15T07:30:00",
        "v": 2.5,
        "n": "Kalevala, ääkköset ja 🦉, and a note long enough to need more than one padding step",
        "u": 1794000000001,
        "d": False,
    },
    {
        "kind": "metric",
        "id": "running",
        "name": "Running",
        "type": "Fitness",
        "created": "2023-01-01T08:00:00",
        "u": 1794000000000,
        "g": 0,
        "deleted": False,
    },
    {
        "kind": "metric",
        "id": "walking",
        "name": None,
        "type": None,
        "created": None,
        "u": 1794100000000,
        "g": 1794100000000,
        "deleted": True,
    },
]


def generate() -> dict[str, Any]:
    keys = derive_keys(DATA_KEY)
    rows: list[dict[str, Any]] = []
    for i, record in enumerate(RECORDS):
        nonce = fixed(100 + i, 12)
        key, data = encrypt_row(keys, record, nonce)
        rows.append(
            {
                "record": record,
                "plaintext": record_json(record),
                "padded_length": len(pad(record_json(record))),
                "nonce": nonce.hex(),
                "key": key,
                "data": data,
            }
        )
    small_kdf = {"name": "argon2id", "m": 64, "t": 2, "p": 1, "salt": "c2FsdHNhbHRzYWx0c2FsdA"}
    keyring, _ = new_keyring(
        PASSPHRASE,
        now=1794130000000,
        data_key=DATA_KEY,
        vault="Jq9wq3sKp0m2A1xYbXo3Vg",
        entry_id="a7Kq2m",
        salt=fixed(200, 16),
        nonce=fixed(220, 12),
    )
    return {
        "about": "Lokki sync protocol v1 test vectors, written by vectors/generate.py",
        "data_key": DATA_KEY.hex(),
        "derived_keys": {
            "encryption": keys.encryption.hex(),
            "row_names": keys.row_names.hex(),
            "keyring_mac": keys.keyring_mac.hex(),
        },
        "row_keys": [
            {"kind": kind, "id": rid, "key": row_key(keys, kind, rid)}
            for kind, rid in [("entry", UUID), ("metric", "running"), ("metric", UUID)]
        ],
        "rows": rows,
        "argon2id": [
            {
                "passphrase": PASSPHRASE,
                "kdf": small_kdf,
                "output": passphrase_key(PASSPHRASE, small_kdf).hex(),
            },
            # the same passphrase typed with a decomposed "ä" (a + U+0308) gives the same key
            {
                "passphrase": "pääsana",
                "kdf": small_kdf,
                "output": passphrase_key("pääsana", small_kdf).hex(),
            },
            {
                "passphrase": PASSPHRASE,
                "kdf": keyring["keys"][0]["kdf"],
                "output": passphrase_key(PASSPHRASE, keyring["keys"][0]["kdf"]).hex(),
            },
        ],
        "canonical_json": [
            {
                "value": {"b": [2, {"z": 1, "a": "ä"}], "a": None, "c": True},
                "json": canonical_json({"b": [2, {"z": 1, "a": "ä"}], "a": None, "c": True}),
            },
        ],
        "keyring": {
            "passphrase": PASSPHRASE,
            "inputs": {
                "vault": "Jq9wq3sKp0m2A1xYbXo3Vg",
                "entry_id": "a7Kq2m",
                "now": 1794130000000,
                "salt": fixed(200, 16).hex(),
                "nonce": fixed(220, 12).hex(),
            },
            "keyring": keyring,
        },
    }


if __name__ == "__main__":
    OUT.write_text(json.dumps(generate(), ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {OUT}")
