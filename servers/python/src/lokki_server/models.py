"""
Request and response bodies of the HTTP API (docs/sync-protocol.md, section 5.3).

Descriptions and examples here are what Swagger UI (/docs) and ReDoc (/redoc) show: each model's
docstring describes it there, so they're written for the API's readers.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StringConstraints

from lokki_server.names import VAULT_NAME

Scope = Literal["read", "write"]

# Values in examples, matching the protocol doc's
_KEY = "q3Jb0w1sV8ZpK2mXy7c4Ag"
_VAULT_ID = "Jq9wq3sKp0m2A1xYbXo3Vg"
_TIME = 1794130000000

RowKey = Annotated[
    str,
    StringConstraints(pattern=r"^[A-Za-z0-9_-]{22}$"),
    Field(
        description="The row's name: base64url of 16 bytes, without padding (protocol 4.2). "
        "Made by devices from the record's kind and ID; the server can't tell which record it is.",
        examples=[_KEY],
    ),
]
RowData = Annotated[
    str,
    StringConstraints(min_length=1),
    Field(
        description="The encrypted record: `v1.` and base64url of nonce and AES-GCM ciphertext "
        "(protocol 4.3). Padded, so its size says little about what's inside.",
        examples=["v1.mF3kZq0x…"],
    ),
]
Counter = Annotated[int, Field(ge=0)]


class ErrorBody(BaseModel):
    """
    Every error. `error` is a code to act on; `message` is for people. A conflict also says where
    the vault is now (`head` or `keyring_version`), so the device knows what to fetch.
    """

    model_config = ConfigDict(extra="allow")

    error: str = Field(
        description="What went wrong, as a code: `invalid_request`, `unauthorized`, `forbidden`, "
        "`not_found`, `behind`, `different_vault`, `too_large`, `name_taken`, …",
        examples=["behind"],
    )
    message: str = Field(
        description="What went wrong, in English", examples=["Pull first: the vault has changed."]
    )
    head: int | None = Field(
        default=None, description="With `behind` from a push: the vault's head now", examples=[1050]
    )
    keyring_version: int | None = Field(
        default=None,
        description="With `behind` or `different_vault` from a keyring write: its version now",
        examples=[4],
    )


class InfoLimits(BaseModel):
    """Limits a client must respect, and the server enforces."""

    pull: int = Field(description="Most rows one pull returns", examples=[1000])
    push: int = Field(description="Most rows one push may contain", examples=[500])
    row_bytes: int = Field(description="Largest `data` of a row, in bytes", examples=[4096])


class Info(BaseModel):
    """What this server is. Needs no token."""

    server: Literal["lokki"] = Field(default="lokki", description="Always `lokki`")
    version: str = Field(description="The server software's version", examples=["0.1.0"])
    id: str = Field(
        description="The server's random ID, made on its first start and never changed. Devices "
        "recognise a server by it, even after its URL changes.",
        examples=["2c0d4c0e-5b1e-4f35-9b7a-3c86f0e1a2d4"],
    )
    api: list[int] = Field(description="API versions this server speaks", examples=[[1]])
    limits: InfoLimits


class Keyring(BaseModel):
    """
    The vault keyring (protocol 4.4): the vault's key, wrapped by keys made from passphrases.

    The server checks only the format and the vault ID, so it can refuse another vault's keyring.
    Everything else, such as `keys` and `mac`, is stored exactly as sent, including fields it
    doesn't know; the server can't check or read them.
    """

    model_config = ConfigDict(
        extra="allow",
        json_schema_extra={
            "examples": [
                {
                    "format": "lokki-keyring",
                    "version": 1,
                    "vault": _VAULT_ID,
                    "keys": [
                        {
                            "id": "a7Kq2m",
                            "type": "passphrase",
                            "created": _TIME,
                            "kdf": {"name": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "…"},
                            "wrapped": "…",
                        }
                    ],
                    "u": _TIME,
                    "mac": "Hq2v…",
                }
            ]
        },
    )

    format: Literal["lokki-keyring"] = Field(description="Always `lokki-keyring`")
    version: int = Field(description="The keyring format's version", examples=[1])
    vault: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        description="The vault's ID, made by the device that created the vault. Unrelated to the "
        "vault's name on the server, which the API never shows.",
        examples=[_VAULT_ID],
    )
    u: int = Field(
        description="When the keyring was last changed, in milliseconds since 1970 (UTC)",
        examples=[_TIME],
    )


class Vault(BaseModel):
    """The vault the token belongs to: its keyring and status."""

    keyring: dict[str, JsonValue] | None = Field(
        description="The keyring exactly as last written, or null for a new, empty vault"
    )
    keyring_version: int = Field(
        description="How many times the keyring was written; 0 while there is none", examples=[3]
    )
    head: int = Field(
        description="The vault's counter: the number of the latest row written", examples=[1042]
    )
    rows: int = Field(description="How many rows the vault holds", examples=[16977])
    changed: str = Field(
        description="When a row or the keyring last changed (ISO 8601, UTC)",
        examples=["2026-11-08T07:31:04Z"],
    )


class KeyringPut(BaseModel):
    """A new keyring, written only if nobody wrote one since the device read it."""

    base: Counter = Field(
        description="The `keyring_version` the device last read; 0 when there's no keyring yet",
        examples=[3],
    )
    keyring: Keyring


class KeyringVersion(BaseModel):
    """The keyring was written."""

    keyring_version: int = Field(description="The keyring's version now", examples=[4])


class RowOut(BaseModel):
    """A row as stored."""

    key: str = Field(description="The row's name (protocol 4.2)", examples=[_KEY])
    seq: int = Field(
        description="The row's number: the vault's counter when it was last written",
        examples=[1041],
    )
    data: str = Field(description="The encrypted record (protocol 4.3)", examples=["v1.mF3k…"])


class Pull(BaseModel):
    """Rows written after `since`, oldest first."""

    rows: list[RowOut]
    cursor: int = Field(
        description="Pass this as `since` in the next request while `more` is true; once it's "
        "false, remember it for the next sync",
        examples=[1042],
    )
    more: bool = Field(description="Whether there are more rows to fetch now", examples=[False])
    head: int = Field(
        description="The vault's counter. A `since` above it means the server lost changes "
        "(protocol 7.4).",
        examples=[1042],
    )


class RowIn(BaseModel):
    """A row to add, or to replace the row with the same key."""

    key: RowKey
    data: RowData


class Push(BaseModel):
    """Rows to write, all or none, only if nobody wrote since the device last pulled."""

    base: Counter = Field(
        description="The vault's `head` when the device last pulled. If it has changed, nothing "
        "is written: pull first.",
        examples=[1042],
    )
    rows: Annotated[list[RowIn], Field(min_length=1)] = Field(
        description="At most `limits.push` rows, each key once"
    )


class Head(BaseModel):
    """The rows were written."""

    head: int = Field(
        description="The vault's counter now; the rows got the numbers after `base`",
        examples=[1044],
    )


class TestVaultRequest(BaseModel):
    """A vault to create for tests."""

    name: Annotated[str, StringConstraints(pattern=f"^{VAULT_NAME.pattern}$")] | None = Field(
        default=None,
        description="The vault's name; leave it out to have one made up",
        examples=["conformance"],
    )


class TestVaultTokens(BaseModel):
    """The test vault, and a token of each scope for it."""

    name: str = Field(description="The vault's name", examples=["test-3f9a1c2b7d4e"])
    write: str = Field(description="A token that can read and write", examples=["lk_6Yq3kM0p…"])
    read: str = Field(description="A token that can only read", examples=["lk_Pw81dQe2…"])
