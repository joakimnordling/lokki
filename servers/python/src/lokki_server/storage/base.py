"""The storage interface: what the API needs from a database, whichever it is."""

from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from lokki_server.models import Scope

# Each storage's own identifiers: numbers in SQL, document IDs in Firestore. Never shown to anyone.
type VaultId = int | str
type TokenId = int | str


@dataclass(
    frozen=True,
    slots=True,
)
class Token:
    """A token as stored: its vault and what it may do. The token itself is never stored."""

    token_id: TokenId
    vault_id: VaultId
    scope: Scope
    last_used: int | None


@dataclass(
    frozen=True,
    slots=True,
)
class VaultStatus:
    """
    A vault's keyring and counters, and the latest push's mark (None before the first). Times are
    milliseconds since 1970 (UTC).
    """

    keyring: str | None
    keyring_version: int
    head: int
    mark: str | None
    rows: int
    changed: int


@dataclass(
    frozen=True,
    slots=True,
)
class Row:
    """A stored row."""

    key: str
    seq: int
    data: str


@dataclass(
    frozen=True,
    slots=True,
)
class PullResult:
    """
    Rows after a sequence number, and where to continue.

    `at_mark` is the mark of the push that wrote row number `at` (by default `since`), and `mark`
    that of the push that wrote row number `cursor`: None for 0, or when the server doesn't know
    (it has forgotten that push, or never had it). `at_mark` is read after the rows, so a history
    that changed meanwhile shows in it.
    """

    rows: list[Row]
    cursor: int
    more: bool
    head: int
    at_mark: str | None
    mark: str | None


class Outcome(Enum):
    """How a conditional write went."""

    OK = "ok"
    BEHIND = "behind"
    DIFFERENT_VAULT = "different_vault"


@dataclass(
    frozen=True,
    slots=True,
)
class WriteResult:
    """The outcome of a conditional write, and the counter after it (for a push, also its mark)."""

    outcome: Outcome
    version: int
    mark: str | None = None


class NameTaken(Exception):
    """A vault with this name, or a token with this label in the vault, exists already."""


@dataclass(
    frozen=True,
    slots=True,
)
class VaultSummary:
    """A vault, for the command line. Its internal number is never shown."""

    name: str
    head: int
    rows: int
    tokens: int
    created: int


@dataclass(
    frozen=True,
    slots=True,
)
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

    Each push gets a mark, a random ID, which tells this vault's history apart from another one
    that reached the same numbers, e.g. after the database was restored from a backup and devices
    pushed again (protocol 7.4). The storage remembers the marks of the latest `history` pushes,
    together with the rows each wrote (`base` + 1 to its `head`), and forgets older ones in the same
    transaction as a push.
    """

    async def server_id(self) -> str:
        """The server's ID, made on first use and never changed."""
        ...

    async def close(self) -> None:
        """Release connections."""
        ...

    # vaults and tokens

    async def create_vault(self, name: str, now: int) -> VaultId:
        """Create an empty vault; returns its internal number. NameTaken if the name is in use."""
        ...

    async def find_vault(self, name: str) -> VaultId | None:
        """The internal number of the vault with this name, if any."""
        ...

    async def add_token(
        self,
        vault_id: VaultId,
        label: str,
        token_hash: str,
        scope: Scope,
        now: int,
    ) -> None:
        """Store a token's hash for a vault. NameTaken if the vault has a token with this label."""
        ...

    async def find_token(self, token_hash: str) -> Token | None:
        """The token with this hash, if any."""
        ...

    async def touch_token(self, token_id: TokenId, now: int) -> None:
        """Record that a token was used."""
        ...

    async def revoke_token(self, vault_id: VaultId, label: str) -> bool:
        """Delete the vault's token with this label; False if there was none."""
        ...

    async def list_vaults(self) -> list[VaultSummary]:
        """Every vault, by name."""
        ...

    async def list_tokens(self, vault_id: VaultId) -> list[TokenSummary]:
        """A vault's tokens, oldest first."""
        ...

    async def delete_vault(self, vault_id: VaultId) -> bool:
        """Delete a vault with its keyring, rows and tokens; False if there was none."""
        ...

    # the vault

    async def vault(self, vault_id: VaultId) -> VaultStatus:
        """The vault's keyring and counters."""
        ...

    async def put_keyring(
        self,
        vault_id: VaultId,
        base: int,
        keyring: str,
        keyring_vault_id: str,
        now: int,
    ) -> WriteResult:
        """Replace the keyring if `base` is the current keyring version and its vault ID matches."""
        ...

    async def pull(
        self,
        vault_id: VaultId,
        since: int,
        limit: int,
        at: int | None = None,
    ) -> PullResult:
        """Rows written after `since`, oldest first, at most `limit`, and the mark of row `at`."""
        ...

    async def push(
        self,
        vault_id: VaultId,
        base: int,
        base_mark: str | None,
        new_rows: list[tuple[str, str]],
        new_mark: str,
        history: int,
        now: int,
    ) -> WriteResult:
        """
        Write `(key, data)` rows with the next sequence numbers if `base` is the current head and
        `base_mark` the mark of the latest push (None before the first). Records the push with
        `new_mark`, keeping the marks of the latest `history` pushes.
        """
        ...
