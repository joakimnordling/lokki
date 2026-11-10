"""Storage directly: atomic conditional writes on every storage; SQL migrations and settings."""

import asyncio
import sqlite3
from contextlib import closing

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import Connection, event

from lokki_server.config import Pool, Settings
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
    # Fewer on the Firestore emulator: it locks documents pessimistically, so transactions that
    # all read the vault and then write it can deadlock until its lock timeout, retries and all.
    # Firestore itself keeps a retried transaction's place in line.
    devices = 4 if database_url.startswith("firestore:") else 8

    async def scenario() -> list[Outcome]:
        storage = open_storage(database_url)
        try:
            vault = await storage.create_vault("race", 0)
            results = await asyncio.gather(
                *(
                    storage.push(
                        vault,
                        0,
                        None,
                        [(key(n), f"v1.{n}")],
                        f"mark{n}",
                        1000,
                        0,
                    )
                    for n in range(devices)
                )
            )
            pulled = await storage.pull(vault, 0, 100)
            assert len(pulled.rows) == 1
            assert pulled.head == 1
            return [r.outcome for r in results]
        finally:
            await storage.close()

    outcomes = asyncio.run(scenario())

    assert outcomes.count(Outcome.OK) == 1
    assert outcomes.count(Outcome.BEHIND) == devices - 1


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


def test_marks_tell_which_push_wrote_a_row(database_url: str) -> None:
    async def scenario() -> None:
        storage = open_storage(database_url)
        try:
            vault = await storage.create_vault("marks", 0)
            first = await storage.pull(vault, 0, 10)
            assert (first.since_mark, first.mark) == (None, None)

            a = await storage.push(vault, 0, None, [(key(1), "v1.1"), (key(2), "v1.2")], "a", 9, 0)
            assert (a.outcome, a.version, a.mark) == (Outcome.OK, 2, "a")
            b = await storage.push(vault, 2, "a", [(key(3), "v1.3")], "b", 9, 0)
            assert (b.outcome, b.version, b.mark) == (Outcome.OK, 3, "b")

            marks = [(await storage.pull(vault, since, 10)).since_mark for since in range(5)]
            assert marks == [None, "a", "a", "b", None]  # 0, rows 1-2, row 3, above the head
            everything = await storage.pull(vault, 0, 10)
            assert (everything.cursor, everything.mark) == (3, "b")
            page = await storage.pull(vault, 0, 1)
            assert (page.cursor, page.more, page.mark) == (1, True, "a")
        finally:
            await storage.close()

    asyncio.run(scenario())


def test_a_push_needs_the_latest_mark(database_url: str) -> None:
    """The same head in another history isn't the same place: nothing is written."""

    async def scenario() -> None:
        storage = open_storage(database_url)
        try:
            vault = await storage.create_vault("marks", 0)
            behind = await storage.push(vault, 0, "a", [(key(1), "v1.1")], "x", 9, 0)
            assert (behind.outcome, behind.version) == (Outcome.BEHIND, 0)
            await storage.push(vault, 0, None, [(key(1), "v1.1")], "a", 9, 0)
            for mark in (None, "other"):
                behind = await storage.push(vault, 1, mark, [(key(2), "v1.2")], "x", 9, 0)
                assert (behind.outcome, behind.version) == (Outcome.BEHIND, 1)
            pulled = await storage.pull(vault, 0, 10)
            assert (pulled.head, pulled.mark, len(pulled.rows)) == (1, "a", 1)
        finally:
            await storage.close()

    asyncio.run(scenario())


def test_only_the_latest_pushes_are_remembered(database_url: str) -> None:
    async def scenario() -> None:
        storage = open_storage(database_url)
        try:
            vault = await storage.create_vault("marks", 0)

            async def push(base: int, mark: str | None, new: str, history: int) -> None:
                result = await storage.push(
                    vault, base, mark, [(key(base + 1), "v1")], new, history, 0
                )
                assert result.outcome is Outcome.OK

            async def remembered() -> list[str | None]:
                return [(await storage.pull(vault, since, 10)).since_mark for since in range(1, 5)]

            await push(0, None, "a", 2)
            await push(1, "a", "b", 2)
            await push(2, "b", "c", 2)
            assert await remembered() == [None, "b", "c", None]
            # a smaller setting forgets the rest with the next push
            await push(3, "c", "d", 1)
            assert await remembered() == [None, None, None, "d"]
            assert (await storage.pull(vault, 0, 10)).mark == "d"
        finally:
            await storage.close()

    asyncio.run(scenario())


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


def _downgrade(url: str, revision: str) -> None:
    config = Config()
    config.set_main_option("script_location", "lokki_server:migrations")
    config.attributes["url"] = url
    command.downgrade(config, revision)


def test_migrations_go_down_and_up_again(sqlite_url: str) -> None:
    _downgrade(sqlite_url, "base")
    migrate(sqlite_url)


def test_vaults_with_rows_get_a_push_covering_them(sqlite_url: str) -> None:
    """Migration 0002: devices that synced before don't know its mark, so they pull everything."""
    _downgrade(sqlite_url, "0001")
    path = sqlite_url.removeprefix("sqlite+aiosqlite:///")
    with closing(sqlite3.connect(path)) as db, db:
        for name, head in (("empty", 0), ("used", 7)):
            db.execute(
                "INSERT INTO vaults (name, head, keyring_version, created, changed)"
                " VALUES (?, ?, 0, 0, 0)",
                (name, head),
            )
    migrate(sqlite_url)

    async def scenario() -> None:
        storage = open_storage(sqlite_url)
        try:
            empty, used = await storage.find_vault("empty"), await storage.find_vault("used")
            assert empty is not None
            assert used is not None
            assert (await storage.pull(empty, 0, 10)).mark is None
            pulled = await storage.pull(used, 0, 10)
            assert pulled.mark is not None
            assert (await storage.pull(used, 1, 10)).since_mark == pulled.mark
            pushed = await storage.push(used, 7, pulled.mark, [(key(1), "v1")], "next", 9, 0)
            assert pushed.outcome is Outcome.OK
        finally:
            await storage.close()

    asyncio.run(scenario())


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
            await storage.push(vault, 0, None, [(key(1), "v1.a")], "a", 1000, 0)
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
    default = engine_options("postgresql+asyncpg://lokki@db.example.com/lokki", Pool())
    chosen = engine_options(
        "postgresql+asyncpg://lokki@db.example.com/lokki",
        Pool(size=1, max_overflow=0, recycle=60),
    )

    assert default["pool_size"] + default["max_overflow"] <= 5
    assert default["pool_pre_ping"] is True
    assert (chosen["pool_size"], chosen["max_overflow"], chosen["pool_recycle"]) == (1, 0, 60)


def test_sqlite_keeps_sqlalchemys_pool() -> None:
    assert engine_options("sqlite+aiosqlite:///lokki.db", Pool()) == {}


def test_the_pool_is_set_with_lokki_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOKKI_POOL__SIZE", "5")
    monkeypatch.setenv("LOKKI_POOL__MAX_OVERFLOW", "0")

    assert Settings().pool == Pool(size=5, max_overflow=0, recycle=1800)
