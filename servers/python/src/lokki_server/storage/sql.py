"""Storage in an SQL database through SQLAlchemy Core: SQLite and PostgreSQL."""

import uuid
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy import delete, event, func, insert, make_url, or_, select, update
from sqlalchemy.engine.interfaces import DBAPIConnection
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine
from sqlalchemy.pool import ConnectionPoolEntry

from lokki_server.config import Pool
from lokki_server.models import Scope
from lokki_server.storage.base import (
    NameTaken,
    Outcome,
    PullResult,
    Row,
    Token,
    TokenId,
    TokenSummary,
    VaultId,
    VaultStatus,
    VaultSummary,
    WriteResult,
)
from lokki_server.storage.schema import rows, server, tokens, vaults


def engine_url(url: str) -> str:
    """
    The URL for SQLAlchemy's async engine, also from what database services hand out.

    A plain postgres:// or postgresql:// URL (e.g. from Aiven or Neon) gets the asyncpg driver, and
    libpq's sslmode=... becomes asyncpg's ssl=..., which means the same.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("postgres", "postgresql"):
        return url
    query = [("ssl" if k == "sslmode" else k, v) for k, v in parse_qsl(parts.query)]
    return urlunsplit(parts._replace(scheme="postgresql+asyncpg", query=urlencode(query)))


def engine_options(url: str, pool: Pool) -> dict[str, Any]:
    """
    The engine's settings for an engine URL: a database server's pool (PostgreSQL, or any added
    later) from the settings, its connections checked before use. SQLite, a file, keeps
    SQLAlchemy's defaults.
    """
    if make_url(url).get_backend_name() == "sqlite":
        return {}
    return {
        "pool_size": pool.size,
        "max_overflow": pool.max_overflow,
        "pool_recycle": pool.recycle,
        "pool_pre_ping": True,
    }


def _sqlite_pragmas(dbapi_connection: DBAPIConnection, _record: ConnectionPoolEntry) -> None:
    cursor = dbapi_connection.cursor()
    # WAL lets readers continue while a push is written; wait for a busy database, don't fail
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=10000")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


class SqlStorage:
    """The storage interface on an SQLAlchemy async engine."""

    def __init__(self, url: str, pool: Pool | None = None) -> None:
        url = engine_url(url)
        self.engine: AsyncEngine = create_async_engine(
            url,
            **engine_options(
                url,
                pool or Pool(),
            ),
        )
        if self.engine.dialect.name == "sqlite":
            event.listen(
                self.engine.sync_engine,
                "connect",
                _sqlite_pragmas,
            )

    async def close(self) -> None:
        await self.engine.dispose()

    async def server_id(self) -> str:
        async with self.engine.begin() as conn:
            found = await conn.scalar(select(server.c.value).where(server.c.name == "id"))
            if found is not None:
                return found
        try:
            async with self.engine.begin() as conn:
                await conn.execute(
                    insert(server).values(
                        name="id",
                        value=str(uuid.uuid4()),
                    )
                )
        except IntegrityError:
            pass  # another process made it first
        async with self.engine.begin() as conn:
            return (
                await conn.execute(select(server.c.value).where(server.c.name == "id"))
            ).scalar_one()

    # vaults and tokens

    async def create_vault(self, name: str, now: int) -> VaultId:
        try:
            async with self.engine.begin() as conn:
                result = await conn.execute(
                    insert(vaults)
                    .values(
                        name=name,
                        head=0,
                        keyring_version=0,
                        created=now,
                        changed=now,
                    )
                    .returning(vaults.c.id)
                )
                return result.scalar_one()
        except IntegrityError as e:
            raise NameTaken(name) from e

    async def find_vault(self, name: str) -> VaultId | None:
        async with self.engine.connect() as conn:
            return await conn.scalar(select(vaults.c.id).where(vaults.c.name == name))

    async def add_token(
        self,
        vault_id: VaultId,
        label: str,
        token_hash: str,
        scope: Scope,
        now: int,
    ) -> None:
        try:
            async with self.engine.begin() as conn:
                await conn.execute(
                    insert(tokens).values(
                        vault_id=vault_id,
                        label=label,
                        hash=token_hash,
                        scope=scope,
                        created=now,
                    )
                )
        except IntegrityError as e:
            raise NameTaken(label) from e

    async def find_token(self, token_hash: str) -> Token | None:
        async with self.engine.connect() as conn:
            found = (
                await conn.execute(
                    select(
                        tokens.c.id,
                        tokens.c.vault_id,
                        tokens.c.scope,
                        tokens.c.last_used,
                    ).where(tokens.c.hash == token_hash)
                )
            ).first()
        if found is None:
            return None
        return Token(
            token_id=found.id,
            vault_id=found.vault_id,
            scope=Scope(found.scope),
            last_used=found.last_used,
        )

    async def touch_token(self, token_id: TokenId, now: int) -> None:
        async with self.engine.begin() as conn:
            await conn.execute(update(tokens).where(tokens.c.id == token_id).values(last_used=now))

    async def revoke_token(self, vault_id: VaultId, label: str) -> bool:
        async with self.engine.begin() as conn:
            result = await conn.execute(
                delete(tokens).where(tokens.c.vault_id == vault_id, tokens.c.label == label)
            )
            return result.rowcount == 1

    async def list_vaults(self) -> list[VaultSummary]:
        row_count = select(func.count()).where(rows.c.vault_id == vaults.c.id).scalar_subquery()
        token_count = select(func.count()).where(tokens.c.vault_id == vaults.c.id).scalar_subquery()
        async with self.engine.connect() as conn:
            found = await conn.execute(
                select(
                    vaults.c.name,
                    vaults.c.head,
                    vaults.c.created,
                    row_count.label("rows"),
                    token_count.label("tokens"),
                ).order_by(vaults.c.name)
            )
            return [
                VaultSummary(
                    name=r.name,
                    head=r.head,
                    rows=r.rows,
                    tokens=r.tokens,
                    created=r.created,
                )
                for r in found
            ]

    async def list_tokens(self, vault_id: VaultId) -> list[TokenSummary]:
        async with self.engine.connect() as conn:
            found = await conn.execute(
                select(tokens).where(tokens.c.vault_id == vault_id).order_by(tokens.c.id)
            )
            return [
                TokenSummary(
                    label=r.label,
                    scope=Scope(r.scope),
                    created=r.created,
                    last_used=r.last_used,
                )
                for r in found
            ]

    async def delete_vault(self, vault_id: VaultId) -> bool:
        async with self.engine.begin() as conn:
            await conn.execute(delete(rows).where(rows.c.vault_id == vault_id))
            await conn.execute(delete(tokens).where(tokens.c.vault_id == vault_id))
            result = await conn.execute(delete(vaults).where(vaults.c.id == vault_id))
            return result.rowcount == 1

    # the vault

    async def vault(self, vault_id: VaultId) -> VaultStatus:
        async with self.engine.connect() as conn:
            found = (
                await conn.execute(
                    select(
                        vaults.c.keyring,
                        vaults.c.keyring_version,
                        vaults.c.head,
                        vaults.c.changed,
                    ).where(vaults.c.id == vault_id)
                )
            ).one()
            count = await conn.scalar(
                select(func.count()).select_from(rows).where(rows.c.vault_id == vault_id)
            )
        return VaultStatus(
            keyring=found.keyring,
            keyring_version=found.keyring_version,
            head=found.head,
            rows=count or 0,
            changed=found.changed,
        )

    async def put_keyring(
        self,
        vault_id: VaultId,
        base: int,
        keyring: str,
        keyring_vault_id: str,
        now: int,
    ) -> WriteResult:
        async with self.engine.begin() as conn:
            # One conditional update: only from the expected version, and only for the same vault
            # (or the first keyring). Two devices can't both succeed from the same base.
            result = await conn.execute(
                update(vaults)
                .where(
                    vaults.c.id == vault_id,
                    vaults.c.keyring_version == base,
                    or_(
                        vaults.c.keyring_vault_id.is_(None),
                        vaults.c.keyring_vault_id == keyring_vault_id,
                    ),
                )
                .values(
                    keyring=keyring,
                    keyring_vault_id=keyring_vault_id,
                    keyring_version=vaults.c.keyring_version + 1,
                    changed=now,
                )
            )
            current = (
                await conn.execute(
                    select(vaults.c.keyring_version, vaults.c.keyring_vault_id).where(
                        vaults.c.id == vault_id
                    )
                )
            ).one()
        if result.rowcount == 1:
            return WriteResult(Outcome.OK, current.keyring_version)
        if current.keyring_vault_id is not None and current.keyring_vault_id != keyring_vault_id:
            return WriteResult(Outcome.DIFFERENT_VAULT, current.keyring_version)
        return WriteResult(Outcome.BEHIND, current.keyring_version)

    async def pull(
        self,
        vault_id: VaultId,
        since: int,
        limit: int,
    ) -> PullResult:
        async with self.engine.connect() as conn:
            # Read the head first and only rows up to it: a push committing meanwhile only adds
            # rows above it, which the next pull fetches.
            head = await self._head(conn, vault_id)
            found = (
                await conn.execute(
                    select(
                        rows.c.key,
                        rows.c.seq,
                        rows.c.data,
                    )
                    .where(
                        rows.c.vault_id == vault_id,
                        rows.c.seq > since,
                        rows.c.seq <= head,
                    )
                    .order_by(rows.c.seq)
                    .limit(limit + 1)
                )
            ).all()
        more = len(found) > limit
        page = [
            Row(
                key=r.key,
                seq=r.seq,
                data=r.data,
            )
            for r in found[:limit]
        ]
        return PullResult(
            rows=page,
            cursor=page[-1].seq if more else head,
            more=more,
            head=head,
        )

    async def push(
        self,
        vault_id: VaultId,
        base: int,
        new_rows: list[tuple[str, str]],
        now: int,
    ) -> WriteResult:
        async with self.engine.begin() as conn:
            # Claim the numbers base+1 .. base+n, only if nobody has pushed since `base`.
            claimed = await conn.execute(
                update(vaults)
                .where(vaults.c.id == vault_id, vaults.c.head == base)
                .values(
                    head=vaults.c.head + len(new_rows),
                    changed=now,
                )
            )
            if claimed.rowcount != 1:
                return WriteResult(Outcome.BEHIND, await self._head(conn, vault_id))
            keys = [key for key, _ in new_rows]
            await conn.execute(
                delete(rows).where(rows.c.vault_id == vault_id, rows.c.key.in_(keys))
            )
            await conn.execute(
                insert(rows),
                [
                    {"vault_id": vault_id, "key": key, "seq": base + i, "data": data}
                    for i, (key, data) in enumerate(
                        new_rows,
                        start=1,
                    )
                ],
            )
            return WriteResult(Outcome.OK, base + len(new_rows))

    @staticmethod
    async def _head(conn: AsyncConnection, vault_id: VaultId) -> int:
        return (
            await conn.execute(select(vaults.c.head).where(vaults.c.id == vault_id))
        ).scalar_one()
