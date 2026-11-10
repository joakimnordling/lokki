"""Values for tests: row keys (22 base64url characters) and keyrings."""

import base64
from typing import Any


def key(n: int) -> str:
    """A valid row key, different for each `n`."""
    return base64.urlsafe_b64encode(n.to_bytes(16, "big")).decode().rstrip("=")


def keyring(
    vault: str = "Jq9wq3sKp0m2A1xYbXo3Vg", u: int = 1794130000000, **extra: Any
) -> dict[str, Any]:
    """A keyring as a device would send it. The server never checks keys or mac."""
    return {
        "format": "lokki-keyring",
        "app": "lokki",
        "version": 1,
        "vault": vault,
        "keys": [
            {
                "id": "a7Kq2m",
                "type": "passphrase",
                "created": 1794130000000,
                "kdf": {
                    "name": "argon2id",
                    "m": 65536,
                    "t": 3,
                    "p": 1,
                    "salt": "c2FsdHNhbHRzYWx0c2FsdA",
                },
                "wrapped": "x7Gk",
            }
        ],
        "u": u,
        "mac": "Hq2v",
        **extra,
    }
