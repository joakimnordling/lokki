"""The SQL storage directly: atomic conditional writes, and migrations matching the tables."""

import asyncio

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Connection, event

from lokki_server.storage import migrate
from lokki_server.storage.base import Outcome
from lokki_server.storage.schema import metadata
from lokki_server.storage.sql import SqlStorage, _sqlite_pragmas  # pyright: ignore[reportPrivateUsage]
from tests.helpers import key


def test_concurrent_pushes_from_the_same_base(database_url: str) -> None:
    async def scenario() -> list[Outcome]:
        storage = SqlStorage(database_url)
        try:
            vault = await storage.create_vault("race", 0)
            results = await asyncio.gather(
                *(storage.push(vault, 0, [(key(n), f"v1.{n}")], 0) for n in range(8))
            )
            pulled = await storage.pull(vault, 0, 100)
            assert len(pulled.rows) == 1
            assert pulled.head == 1
            return [r.outcome for r in results]
        finally:
            await storage.close()

    outcomes = asyncio.run(scenario())

    assert outcomes.count(Outcome.OK) == 1
    assert outcomes.count(Outcome.BEHIND) == 7


def test_concurrent_first_keyrings(database_url: str) -> None:
    async def scenario() -> list[Outcome]:
        storage = SqlStorage(database_url)
        try:
            vault = await storage.create_vault("race", 0)
            results = await asyncio.gather(
                *(storage.put_keyring(vault, 0, "{}", f"vault-{n}", 0) for n in range(4))
            )
            return [r.outcome for r in results]
        finally:
            await storage.close()

    outcomes = asyncio.run(scenario())

    assert outcomes.count(Outcome.OK) == 1
    assert outcomes.count(Outcome.DIFFERENT_VAULT) == 3


def test_server_id_is_made_once(database_url: str) -> None:
    async def ids() -> list[str]:
        storage = SqlStorage(database_url)
        try:
            return list(await asyncio.gather(*(storage.server_id() for _ in range(4))))
        finally:
            await storage.close()

    first = asyncio.run(ids())

    assert len(set(first)) == 1
    assert asyncio.run(ids()) == first


def test_migrations_match_the_tables(database_url: str) -> None:
    async def differences() -> list[object]:
        storage = SqlStorage(database_url)
        try:
            async with storage.engine.connect() as conn:

                def compare(sync_conn: Connection) -> list[object]:
                    return list(compare_metadata(MigrationContext.configure(sync_conn), metadata))

                return await conn.run_sync(compare)
        finally:
            await storage.close()

    assert asyncio.run(differences()) == []


def test_migrations_go_down_and_up_again(database_url: str) -> None:
    migrate(database_url, "base")
    migrate(database_url)


def test_sqlite_settings_only_for_sqlite(database_url: str) -> None:
    async def scenario() -> tuple[bool, bool]:
        sqlite = SqlStorage(database_url)
        # Makes the engine only: nothing connects, so no PostgreSQL is needed
        postgres = SqlStorage("postgresql+asyncpg://lokki@db.example.com/lokki")
        try:
            return (
                event.contains(sqlite.engine.sync_engine, "connect", _sqlite_pragmas),
                event.contains(postgres.engine.sync_engine, "connect", _sqlite_pragmas),
            )
        finally:
            await sqlite.close()
            await postgres.close()

    assert asyncio.run(scenario()) == (True, False)
