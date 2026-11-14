"""
Keys, row names, row encryption and the vault keyring (docs/sync-protocol.md, section 4).

Several apps can use the protocol, each with its own name (``lokki`` for Lokki) in its key labels,
additional data and keyrings, so one app's keys never open another's rows. Every function that
needs it takes the app's name.

Everything here is deterministic when given the "random" values (nonces, salts, IDs), which is how
the test vectors in ``protocol/vectors`` are made.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from argon2.low_level import Type, hash_secret_raw
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

type Json = dict[str, Any]

ROW_VERSION = "v1"
MIN_PADDED = 192
PAD_STEP = 64
# Argon2id settings for new passphrase entries: 64 MiB, 3 iterations, 1 lane
DEFAULT_KDF: Json = {"name": "argon2id", "m": 65536, "t": 3, "p": 1}

_B64URL = re.compile(r"^[A-Za-z0-9_-]*$")
_APP_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")


def app_name(app: str) -> str:
    """The app's name, if it's one: lowercase letters, digits and dashes, at most 32."""
    if not _APP_NAME.fullmatch(app):
        raise ValueError(f"not an app name: {app!r}")
    return app


class FormatError(Exception):
    """A row written in a format this implementation doesn't know (e.g. by a newer app)."""


class DamagedRowError(Exception):
    """A row that doesn't decrypt, or whose contents don't belong to its key."""


class WrongPassphraseError(Exception):
    """No entry in the keyring opens with this passphrase."""


class DamagedKeyringError(Exception):
    """A keyring whose mac doesn't match: changed by someone without the data key."""


def b64url(data: bytes) -> str:
    """base64url without padding."""
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def unb64url(text: str) -> bytes:
    """The bytes of base64url text, with or without padding."""
    text = text.rstrip("=")
    if not _B64URL.match(text):
        raise ValueError("not base64url")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


@dataclass(frozen=True, slots=True)
class Keys:
    """The keys derived from a vault's data key (section 4.1)."""

    encryption: bytes
    row_names: bytes
    keyring_mac: bytes


def _hkdf(data_key: bytes, info: str) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info.encode()).derive(
        data_key
    )


def derive_keys(data_key: bytes, app: str) -> Keys:
    """HKDF-SHA256 with no salt and the labels from section 4.1, e.g. ``lokki/v1/encryption``."""
    app = app_name(app)
    return Keys(
        encryption=_hkdf(data_key, f"{app}/v1/encryption"),
        row_names=_hkdf(data_key, f"{app}/v1/row-names"),
        keyring_mac=_hkdf(data_key, f"{app}/v1/keyring-mac"),
    )


def _hmac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode(), hashlib.sha256).digest()


def row_key(keys: Keys, kind: str, record_id: str) -> str:
    """A record's row name: the first 16 bytes of HMAC-SHA256 over ``kind:id`` (section 4.2)."""
    return b64url(_hmac(keys.row_names, f"{kind}:{record_id}")[:16])


def record_json(record: Json) -> str:
    """A record as compact JSON, like JavaScript's ``JSON.stringify``."""
    return json.dumps(record, ensure_ascii=False, separators=(",", ":"))


def pad(text: str) -> bytes:
    """UTF-8, then spaces up to at least 192 bytes and a multiple of 64 (section 4.3)."""
    data = text.encode()
    size = max(MIN_PADDED, -(-len(data) // PAD_STEP) * PAD_STEP)
    return data + b" " * (size - len(data))


def _row_aad(app: str, key: str) -> bytes:
    return f"{app_name(app)}/row/{ROW_VERSION}/{key}".encode()


def encrypt_row(
    keys: Keys, record: Json, *, app: str, nonce: bytes | None = None
) -> tuple[str, str]:
    """A record as a row: its key and its encrypted ``data``."""
    key = row_key(keys, record["kind"], record["id"])
    nonce = os.urandom(12) if nonce is None else nonce
    sealed = AESGCM(keys.encryption).encrypt(nonce, pad(record_json(record)), _row_aad(app, key))
    return key, f"{ROW_VERSION}.{b64url(nonce + sealed)}"


def decrypt_row(keys: Keys, key: str, data: str, *, app: str, kinds: tuple[str, ...]) -> Json:
    """The record in a row, one of the app's ``kinds``. Raises FormatError or DamagedRowError."""
    version, dot, payload = data.partition(".")
    if not dot or version != ROW_VERSION:
        raise FormatError(f"unknown row format {version!r}")
    try:
        raw = unb64url(payload)
        if len(raw) < 12 + 16:
            raise DamagedRowError("too short")
        plain = AESGCM(keys.encryption).decrypt(raw[:12], raw[12:], _row_aad(app, key))
        record = json.loads(plain)
    except (InvalidTag, ValueError) as error:
        raise DamagedRowError(str(error)) from error
    if (
        not isinstance(record, dict)
        or record.get("kind") not in kinds  # pyright: ignore[reportUnknownMemberType]
        or not isinstance(record.get("id"), str)  # pyright: ignore[reportUnknownMemberType]
    ):
        raise DamagedRowError("not a record")
    found: Json = record  # pyright: ignore[reportUnknownVariableType]
    if row_key(keys, found["kind"], found["id"]) != key:
        raise DamagedRowError("the record doesn't belong to this key")
    return found


def canonical_json(value: Any) -> str:
    """Sorted keys, no whitespace: what the keyring's mac is computed over (section 4.4)."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def normalize_passphrase(passphrase: str) -> bytes:
    """Unicode NFC, then UTF-8, so the same passphrase typed on any device gives the same key."""
    return unicodedata.normalize("NFC", passphrase).encode()


def passphrase_key(passphrase: str, kdf: Json) -> bytes:
    """Argon2id (version 0x13) of the passphrase with the entry's settings: 32 bytes."""
    if kdf.get("name") != "argon2id":
        raise ValueError(f"unknown key derivation {kdf.get('name')!r}")
    return hash_secret_raw(
        normalize_passphrase(passphrase),
        unb64url(kdf["salt"]),
        time_cost=kdf["t"],
        memory_cost=kdf["m"],
        parallelism=kdf["p"],
        hash_len=32,
        type=Type.ID,
    )


def _key_aad(app: str, vault: str, entry_id: str) -> bytes:
    return f"{app_name(app)}/key/v1/{vault}/{entry_id}".encode()


def keyring_mac(keys: Keys, keyring: Json) -> str:
    """HMAC-SHA256 over the canonical JSON of the keyring without its ``mac``."""
    body = {k: v for k, v in keyring.items() if k != "mac"}
    return b64url(_hmac(keys.keyring_mac, canonical_json(body)))


def passphrase_entry(
    data_key: bytes,
    vault: str,
    passphrase: str,
    *,
    app: str,
    now: int,
    entry_id: str | None = None,
    salt: bytes | None = None,
    nonce: bytes | None = None,
    kdf: Json | None = None,
) -> Json:
    """A ``keys`` entry that opens the data key with a passphrase."""
    entry_id = b64url(os.urandom(6)) if entry_id is None else entry_id
    settings = {**(DEFAULT_KDF if kdf is None else kdf)}
    settings["salt"] = b64url(os.urandom(16) if salt is None else salt)
    nonce = os.urandom(12) if nonce is None else nonce
    wrapped = AESGCM(passphrase_key(passphrase, settings)).encrypt(
        nonce, data_key, _key_aad(app, vault, entry_id)
    )
    return {
        "id": entry_id,
        "type": "passphrase",
        "created": now,
        "kdf": settings,
        "wrapped": b64url(nonce + wrapped),
    }


def seal_keyring(keys: Keys, vault: str, entries: list[Json], u: int, *, app: str) -> Json:
    """A complete keyring with its mac. Its format is ``lokki-keyring`` whatever the app."""
    keyring: Json = {
        "format": "lokki-keyring",
        "version": 1,
        "app": app_name(app),
        "vault": vault,
        "keys": entries,
        "u": u,
    }
    keyring["mac"] = keyring_mac(keys, keyring)
    return keyring


def new_keyring(
    passphrase: str,
    *,
    app: str,
    now: int,
    data_key: bytes | None = None,
    vault: str | None = None,
    entry_id: str | None = None,
    salt: bytes | None = None,
    nonce: bytes | None = None,
    kdf: Json | None = None,
) -> tuple[Json, bytes]:
    """A new vault: its keyring and data key."""
    data_key = os.urandom(32) if data_key is None else data_key
    vault = b64url(os.urandom(16)) if vault is None else vault
    entry = passphrase_entry(
        data_key,
        vault,
        passphrase,
        app=app,
        now=now,
        entry_id=entry_id,
        salt=salt,
        nonce=nonce,
        kdf=kdf,
    )
    return seal_keyring(derive_keys(data_key, app), vault, [entry], now, app=app), data_key


def unlock(keyring: Json, passphrase: str, *, app: str) -> bytes:
    """The data key, if the passphrase opens an entry and the keyring's mac is right."""
    vault: str = keyring["vault"]
    for entry in keyring["keys"]:
        if entry.get("type") != "passphrase":
            continue
        raw = unb64url(entry["wrapped"])
        try:
            data_key = AESGCM(passphrase_key(passphrase, entry["kdf"])).decrypt(
                raw[:12], raw[12:], _key_aad(app, vault, entry["id"])
            )
        except InvalidTag:
            continue
        if not hmac.compare_digest(
            keyring_mac(derive_keys(data_key, app), keyring), keyring["mac"]
        ):
            raise DamagedKeyringError("the keyring's mac doesn't match")
        return data_key
    raise WrongPassphraseError("no entry opens with this passphrase")


def change_passphrase(
    keyring: Json, data_key: bytes, passphrase: str, *, app: str, now: int, **entry_options: Any
) -> Json:
    """The keyring with its passphrase entry replaced (other entries kept), newer ``u``."""
    others = [e for e in keyring["keys"] if e.get("type") != "passphrase"]
    entry = passphrase_entry(
        data_key, keyring["vault"], passphrase, app=app, now=now, **entry_options
    )
    u = max(now, keyring["u"] + 1)  # newer than the keyring it replaces, even with a slow clock
    return seal_keyring(derive_keys(data_key, app), keyring["vault"], [entry, *others], u, app=app)
