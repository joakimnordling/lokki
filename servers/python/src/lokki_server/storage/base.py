"""The storage interface: what the API needs from a database, whichever it is."""

from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from lokki_server.models import Scope


@dataclass(frozen=True, slots=True)
class TokenInfo:
    """Who a token belongs to and what it may do."""

    token_id: int
    vault_id: int
    scope: Scope
    last_used: int | None


@dataclass(frozen=True, slots=True)
class VaultStatus:
    """A vault's keyring and counters. Times are milliseconds since 1970 (UTC)."""

    keyring: str | None
    keyring_version: int
    head: int
    rows: int
    changed: int


@dataclass(frozen=True, slots=True)
class Row:
    """A stored row."""

    key: str
    seq: int
    data: str


@dataclass(frozen=True, slots=True)
class PullResult:
    """Rows after a sequence number, and where to continue."""

    rows: list[Row]
    cursor: int
    more: bool
    head: int


class Outcome(Enum):
    """How a conditional write went."""

    OK = "ok"
    BEHIND = "behind"
    DIFFERENT_VAULT = "different_vault"


@dataclass(frozen=True, slots=True)
class WriteResult:
    """The outcome of a conditional write, and the counter after it."""

    outcome: Outcome
    version: int


class NameTaken(Exception):
    """A vault with this name, or a token with this label in the vault, exists already."""


@dataclass(frozen=True, slots=True)
class VaultSummary:
    """A vault, for the command line. Its internal number is never shown."""

    name: str
    head: int
    rows: int
    tokens: int
    created: int


@dataclass(frozen=True, slots=True)
class TokenSummary:
    """A token, for the command line. The token itself is never stored."""

    label: str
    scope: Scope
    created: int
    last_used: int | None


class Storage(Protocol):
    """
    A database holding the server's ID, vaults, tokens, keyrings and rows.

    Vaults have a unique name, and tokens a label unique within their vault; both are how the
    command line refers to them. Each vault also has an internal number (`vault_id`) that only the
    storage and the API use. It's unrelated to the keyring's vault ID, which devices make.

    Every write that the protocol makes conditional (`put_keyring`, `push`) must be atomic: check
    the counter and write in one transaction, so two devices can never both succeed from the same
    `base`.
    """

    async def server_id(self) -> str:
        """The server's ID, made on first use and never changed."""
        ...

    async def close(self) -> None:
        """Release connections."""
        ...

    # vaults and tokens

    async def create_vault(self, name: str, now: int) -> int:
        """Create an empty vault; returns its internal number. NameTaken if the name is in use."""
        ...

    async def find_vault(self, name: str) -> int | None:
        """The internal number of the vault with this name, if any."""
        ...

    async def add_token(
        self, vault_id: int, label: str, token_hash: str, scope: Scope, now: int
    ) -> None:
        """Store a token's hash for a vault. NameTaken if the vault has a token with this label."""
        ...

    async def find_token(self, token_hash: str) -> TokenInfo | None:
        """The token with this hash, if any."""
        ...

    async def touch_token(self, token_id: int, now: int) -> None:
        """Record that a token was used."""
        ...

    async def revoke_token(self, vault_id: int, label: str) -> bool:
        """Delete the vault's token with this label; False if there was none."""
        ...

    async def list_vaults(self) -> list[VaultSummary]:
        """Every vault, by name."""
        ...

    async def list_tokens(self, vault_id: int) -> list[TokenSummary]:
        """A vault's tokens, oldest first."""
        ...

    async def delete_vault(self, vault_id: int) -> bool:
        """Delete a vault with its keyring, rows and tokens; False if there was none."""
        ...

    # the vault

    async def vault(self, vault_id: int) -> VaultStatus:
        """The vault's keyring and counters."""
        ...

    async def put_keyring(
        self, vault_id: int, base: int, keyring: str, keyring_vault_id: str, now: int
    ) -> WriteResult:
        """Replace the keyring if `base` is the current keyring version and its vault ID matches."""
        ...

    async def pull(self, vault_id: int, since: int, limit: int) -> PullResult:
        """Rows written after `since`, oldest first, at most `limit`."""
        ...

    async def push(
        self, vault_id: int, base: int, new_rows: list[tuple[str, str]], now: int
    ) -> WriteResult:
        """Write `(key, data)` rows with the next sequence numbers if `base` is the current head."""
        ...
