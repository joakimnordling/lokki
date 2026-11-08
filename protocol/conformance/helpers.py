"""Values for the conformance tests."""

import base64
from typing import Any


def key(n: int) -> str:
    """A valid row key (16 bytes, base64url), different for each `n`."""
    return base64.urlsafe_b64encode(n.to_bytes(16, "big")).decode().rstrip("=")


def keyring(vault: str = "Jq9wq3sKp0m2A1xYbXo3Vg", u: int = 1, **extra: Any) -> dict[str, Any]:
    """A keyring. A server stores it as sent and never checks its keys or mac."""
    return {
        "format": "lokki-keyring",
        "version": 1,
        "vault": vault,
        "keys": [{"id": "a7Kq2m", "type": "passphrase", "created": 1, "kdf": {}, "wrapped": "x"}],
        "u": u,
        "mac": "m",
        **extra,
    }
