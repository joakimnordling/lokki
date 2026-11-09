"""Request and response bodies of the HTTP API (docs/sync-protocol.md, section 5.3)."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StringConstraints

from lokki_server.names import VAULT_NAME

# base64url of 16 bytes, without padding: the row's name (protocol 4.2)
RowKey = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{22}$")]
Scope = Literal["read", "write"]


class ErrorBody(BaseModel):
    """Every error response."""

    error: str
    message: str


class InfoLimits(BaseModel):
    """Limits a client must respect."""

    pull: int
    push: int
    row_bytes: int


class Info(BaseModel):
    """``GET /v1/info``."""

    server: Literal["lokki"] = "lokki"
    version: str
    id: str
    api: list[int]
    limits: InfoLimits


class Keyring(BaseModel):
    """
    The vault keyring (protocol 4.4).

    The server checks only what it needs: the format, and the vault's ID so it can refuse a keyring
    of another vault. Everything else is kept as sent, including fields it doesn't know.
    """

    model_config = ConfigDict(extra="allow")

    format: Literal["lokki-keyring"]
    version: int
    vault: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    u: int


class Vault(BaseModel):
    """``GET /v1/vault``."""

    keyring: dict[str, JsonValue] | None
    keyring_version: int
    head: int
    rows: int
    changed: str


class KeyringPut(BaseModel):
    """``PUT /v1/vault/keyring``."""

    base: int = Field(ge=0)
    keyring: Keyring


class KeyringVersion(BaseModel):
    """A successful ``PUT /v1/vault/keyring``."""

    keyring_version: int


class RowOut(BaseModel):
    """A row in a pull."""

    key: str
    seq: int
    data: str


class Pull(BaseModel):
    """``GET /v1/vault/rows``."""

    rows: list[RowOut]
    cursor: int
    more: bool
    head: int


class RowIn(BaseModel):
    """A row in a push."""

    key: RowKey
    data: Annotated[str, StringConstraints(min_length=1)]


class Push(BaseModel):
    """``POST /v1/vault/rows``."""

    base: int = Field(ge=0)
    rows: Annotated[list[RowIn], Field(min_length=1)]


class Head(BaseModel):
    """A successful push."""

    head: int


class TestVaultRequest(BaseModel):
    """``POST /v1/test/vaults`` (test mode only). Without a name, the server makes one up."""

    name: Annotated[str, StringConstraints(pattern=f"^{VAULT_NAME.pattern}$")] | None = None


class TestVaultTokens(BaseModel):
    """A new test vault: its name and tokens."""

    name: str

    write: str
    read: str
