"""The storage interface: what the API needs from a database, whichever it is."""

from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from lokki_server.models import Scope


@dataclass(frozen=True, slots=True)
class TokenInfo:
    """Who a token belongs to and what it may do."""

    token_id: int
    account_id: int
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


@dataclass(frozen=True, slots=True)
class AccountSummary:
    """An account, for the command line."""

    account_id: int
    name: str
    head: int
    rows: int
    tokens: int
    created: int


@dataclass(frozen=True, slots=True)
class TokenSummary:
    """A token, for the command line. The token itself is never stored."""

    token_id: int
    account_id: int
    scope: Scope
    created: int
    last_used: int | None


class Storage(Protocol):
    """
    A database holding the server's ID, accounts, tokens, keyrings and rows.

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

    # accounts and tokens

    async def create_account(self, name: str, now: int) -> int:
        """Create an empty account (and vault); returns its ID."""
        ...

    async def add_token(self, account_id: int, token_hash: str, scope: Scope, now: int) -> int:
        """Store a token's hash for an account; returns the token's ID."""
        ...

    async def find_token(self, token_hash: str) -> TokenInfo | None:
        """The token with this hash, if any."""
        ...

    async def touch_token(self, token_id: int, now: int) -> None:
        """Record that a token was used."""
        ...

    async def revoke_token(self, token_id: int) -> bool:
        """Delete a token; False if there was none."""
        ...

    async def list_accounts(self) -> list[AccountSummary]:
        """Every account, oldest first."""
        ...

    async def list_tokens(self, account_id: int) -> list[TokenSummary]:
        """An account's tokens, oldest first."""
        ...

    async def delete_account(self, account_id: int) -> bool:
        """Delete an account with its keyring, rows and tokens; False if there was none."""
        ...

    # the vault

    async def vault(self, account_id: int) -> VaultStatus:
        """The account's keyring and counters."""
        ...

    async def put_keyring(
        self, account_id: int, base: int, keyring: str, vault: str, now: int
    ) -> WriteResult:
        """Replace the keyring if `base` is the current keyring version and the vault matches."""
        ...

    async def pull(self, account_id: int, since: int, limit: int) -> PullResult:
        """Rows written after `since`, oldest first, at most `limit`."""
        ...

    async def push(
        self, account_id: int, base: int, new_rows: list[tuple[str, str]], now: int
    ) -> WriteResult:
        """Write `(key, data)` rows with the next sequence numbers if `base` is the current head."""
        ...
