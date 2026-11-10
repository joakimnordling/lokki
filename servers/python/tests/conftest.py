"""
Fixtures: a new database per test, the app on it, and vaults made in test mode.

Tests that take `database_url` run on every storage: SQLite always, PostgreSQL when
LOKKI_TEST_POSTGRES_URL names a server to make databases on, and Firestore when an emulator is
running (FIRESTORE_EMULATOR_HOST). CI runs all three. Tests of one storage take `sqlite_url`.
"""

import asyncio
import os
import re
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from syrupy.assertion import SnapshotAssertion
from syrupy.extensions.json import JSONSnapshotExtension
from syrupy.location import PyTestLocation
from syrupy.types import SnapshotIndex

from lokki_server.app import create_app
from lokki_server.config import Limits, Settings
from lokki_server.storage import migrate
from lokki_server.storage.sql import engine_url

ORIGIN = "https://lokki.example.com"


@pytest.fixture
def sqlite_url(tmp_path: Path) -> str:
    """A new, migrated SQLite database."""
    url = f"sqlite+aiosqlite:///{tmp_path / 'lokki.db'}"
    migrate(url)
    return url


@pytest.fixture(params=["sqlite", "postgresql", "firestore"])
def database_url(request: pytest.FixtureRequest, tmp_path: Path) -> str:
    """A new, empty database on each storage."""
    if request.param == "sqlite":
        url = f"sqlite+aiosqlite:///{tmp_path / 'lokki.db'}"
        migrate(url)
        return url
    if request.param == "postgresql":
        server = os.environ.get("LOKKI_TEST_POSTGRES_URL")
        if not server:
            pytest.skip("no PostgreSQL to test on (LOKKI_TEST_POSTGRES_URL)")
        url = _new_postgres_database(server)
        migrate(url)
        return url
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        pytest.skip("no Firestore emulator running (FIRESTORE_EMULATOR_HOST)")
    # The emulator keeps each project's data apart: a new project is an empty database
    return f"firestore://test-{uuid.uuid4().hex[:12]}"


def _new_postgres_database(server: str) -> str:
    """A new database on this PostgreSQL server, e.g. postgresql://postgres:secret@127.0.0.1/postgres."""
    name = f"test_{uuid.uuid4().hex[:12]}"

    async def create() -> None:
        # CREATE DATABASE can't run inside a transaction
        engine = create_async_engine(engine_url(server), isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as connection:
                await connection.execute(text(f'CREATE DATABASE "{name}"'))
        finally:
            await engine.dispose()

    asyncio.run(create())
    return urlunsplit(urlsplit(server)._replace(path=f"/{name}"))


@pytest.fixture
def limits() -> Limits:
    """The limits for the app; small push and row limits make them easy to test."""
    return Limits(pull=1000, push=5, row_bytes=256)


@pytest.fixture
def settings(database_url: str, limits: Limits) -> Settings:
    return Settings(
        database_url=database_url,
        public_url="https://sync.example.com",
        cors_origins=[ORIGIN],
        test_mode=True,
        limits=limits,
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


Tokens = dict[str, str]


@pytest.fixture
def new_vault(client: TestClient) -> Callable[[], Tokens]:
    """Make an empty vault; returns its name and its write and read tokens."""

    def make() -> Tokens:
        response = client.post("/v1/test/vaults", json={})
        assert response.status_code == 201
        tokens: Tokens = response.json()
        return tokens

    return make


@pytest.fixture
def vault(new_vault: Callable[[], Tokens]) -> Tokens:
    return new_vault()


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def writer(vault: Tokens) -> dict[str, str]:
    """Headers for the vault's write token."""
    return bearer(vault["write"])


@pytest.fixture
def reader(vault: Tokens) -> dict[str, str]:
    """Headers for the vault's read token."""
    return bearer(vault["read"])


@pytest.fixture
def snapshot_json(snapshot: SnapshotAssertion) -> SnapshotAssertion:
    return snapshot.use_extension(_SameOnEveryStorage)


class _SameOnEveryStorage(JSONSnapshotExtension):
    """JSON snapshots shared by every storage: the API must answer the same on each."""

    @classmethod
    def get_snapshot_name(cls, *, test_location: PyTestLocation, index: SnapshotIndex = 0) -> str:
        name = super().get_snapshot_name(test_location=test_location, index=index)
        return re.sub(r"\[(sqlite|postgresql|firestore)\]", "", name)
