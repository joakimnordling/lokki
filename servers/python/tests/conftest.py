"""Fixtures: a migrated SQLite database per test, the app on it, and accounts made in test mode."""

from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from syrupy.assertion import SnapshotAssertion
from syrupy.extensions.json import JSONSnapshotExtension

from lokki_server.app import create_app
from lokki_server.config import Limits, Settings
from lokki_server.storage import migrate

ORIGIN = "https://lokki.example.com"


@pytest.fixture
def database_url(tmp_path: Path) -> str:
    """A new, migrated SQLite database."""
    url = f"sqlite+aiosqlite:///{tmp_path / 'lokki.db'}"
    migrate(url)
    return url


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
def new_account(client: TestClient) -> Callable[[], Tokens]:
    """Make an empty account; returns its write and read tokens."""

    def make() -> Tokens:
        response = client.post("/v1/test/accounts", json={"name": "test"})
        assert response.status_code == 201
        tokens: Tokens = response.json()
        return tokens

    return make


@pytest.fixture
def account(new_account: Callable[[], Tokens]) -> Tokens:
    return new_account()


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def writer(account: Tokens) -> dict[str, str]:
    """Headers for the account's write token."""
    return bearer(account["write"])


@pytest.fixture
def reader(account: Tokens) -> dict[str, str]:
    """Headers for the account's read token."""
    return bearer(account["read"])


@pytest.fixture
def snapshot_json(snapshot: SnapshotAssertion) -> SnapshotAssertion:
    return snapshot.use_extension(JSONSnapshotExtension)
