"""Storage directly: atomic conditional writes on every storage; SQL migrations and settings."""

import asyncio
import sqlite3
from contextlib import closing

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Connection, event

from lokki_server.storage import migrate, open_storage
from lokki_server.storage.base import Outcome
from lokki_server.storage.schema import metadata
from lokki_server.storage.sql import (
    SqlStorage,
    _sqlite_pragmas,  # pyright: ignore[reportPrivateUsage]
    engine_options,
    engine_url,
)
from tests.helpers import key


def test_concurrent_pushes_from_the_same_base(database_url: str) -> None:
    async def scenario() -> list[Outcome]:
        storage = open_storage(database_url)
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
        storage = open_storage(database_url)
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
        storage = open_storage(database_url)
        try:
            return list(await asyncio.gather(*(storage.server_id() for _ in range(4))))
        finally:
            await storage.close()

    first = asyncio.run(ids())

    assert len(set(first)) == 1
    assert asyncio.run(ids()) == first


def test_server_id_made_meanwhile_by_another_process(
    sqlite_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Between finding no ID and adding one, another process adds its own: that one is kept."""
    path = sqlite_url.removeprefix("sqlite+aiosqlite:///")

    def another_process_first() -> str:
        with closing(sqlite3.connect(path)) as other, other:
            other.execute("INSERT INTO server (name, value) VALUES ('id', 'theirs')")
        return "ours"

    monkeypatch.setattr("lokki_server.storage.sql.uuid.uuid4", another_process_first)

    async def server_id() -> str:
        storage = SqlStorage(sqlite_url)
        try:
            return await storage.server_id()
        finally:
            await storage.close()

    assert asyncio.run(server_id()) == "theirs"


def test_migrations_match_the_tables(sqlite_url: str) -> None:
    async def differences() -> list[object]:
        storage = SqlStorage(sqlite_url)
        try:
            async with storage.engine.connect() as conn:

                def compare(sync_conn: Connection) -> list[object]:
                    return list(compare_metadata(MigrationContext.configure(sync_conn), metadata))

                return await conn.run_sync(compare)
        finally:
            await storage.close()

    assert asyncio.run(differences()) == []


def test_migrations_go_down_and_up_again(sqlite_url: str) -> None:
    migrate(sqlite_url, "base")
    migrate(sqlite_url)


def test_sqlite_settings_only_for_sqlite(sqlite_url: str) -> None:
    async def scenario() -> tuple[bool, bool]:
        sqlite = SqlStorage(sqlite_url)
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


def test_deleting_a_vault_twice(database_url: str) -> None:
    async def scenario() -> tuple[bool, bool, object]:
        storage = open_storage(database_url)
        try:
            vault = await storage.create_vault("gone", 0)
            first = await storage.delete_vault(vault)
            second = await storage.delete_vault(vault)
            return first, second, await storage.find_vault("gone")
        finally:
            await storage.close()

    assert asyncio.run(scenario()) == (True, False, None)


def test_a_vault_deleted_meanwhile_is_an_error(database_url: str) -> None:
    """A request whose vault was deleted after its token was checked fails, as a 500."""

    async def scenario() -> None:
        storage = open_storage(database_url)
        try:
            vault = await storage.create_vault("gone", 0)
            await storage.delete_vault(vault)
            await storage.vault(vault)
        finally:
            await storage.close()

    with pytest.raises(Exception):  # noqa: B017, PT011 (each storage raises its own)
        asyncio.run(scenario())


@pytest.mark.parametrize(
    ("given", "used"),
    [
        (
            "postgres://avnadmin:secret@pg.example.com:12345/defaultdb?sslmode=require",
            "postgresql+asyncpg://avnadmin:secret@pg.example.com:12345/defaultdb?ssl=require",
        ),
        (
            "postgresql://lokki@db.example.com/lokki",
            "postgresql+asyncpg://lokki@db.example.com/lokki",
        ),
        (
            "postgresql+asyncpg://lokki@db.example.com/lokki?ssl=require",
            "postgresql+asyncpg://lokki@db.example.com/lokki?ssl=require",
        ),
        ("sqlite+aiosqlite:///lokki.db", "sqlite+aiosqlite:///lokki.db"),
    ],
)
def test_database_urls_as_services_hand_them_out(given: str, used: str) -> None:
    assert engine_url(given) == used


def test_postgresql_gets_a_small_pool_checked_before_use() -> None:
    options = engine_options("postgresql+asyncpg://lokki@db.example.com/lokki")

    assert options["pool_size"] + options["max_overflow"] <= 5
    assert options["pool_pre_ping"] is True
    assert engine_options("sqlite+aiosqlite:///lokki.db") == {}
