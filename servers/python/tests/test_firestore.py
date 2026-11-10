"""Choosing Firestore by URL. Its storage runs every API test too, against the emulator in CI."""

import asyncio
import os
import uuid

import pytest

from lokki_server.config import Settings
from lokki_server.storage import migrate, open_storage
from lokki_server.storage.firestore import FirestoreStorage, parse_url


@pytest.mark.parametrize(
    ("url", "project", "database", "prefix"),
    [
        ("firestore://my-project", "my-project", "(default)", "lokki_"),
        ("firestore://my-project/", "my-project", "(default)", "lokki_"),
        ("firestore://my-project/lokki", "my-project", "lokki", "lokki_"),
        ("firestore://my-project?prefix=staging_", "my-project", "(default)", "staging_"),
        ("firestore://my-project?prefix=", "my-project", "(default)", ""),
    ],
)
def test_urls(url: str, project: str, database: str, prefix: str) -> None:
    assert parse_url(url) == (project, database, prefix)


@pytest.mark.parametrize("url", ["firestore:", "firestore:///lokki", "sqlite:///lokki.db"])
def test_urls_that_are_refused(url: str) -> None:
    with pytest.raises(ValueError, match="isn't a Firestore URL"):
        parse_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "firestore://my-project?prefix=a/b",
        "firestore://my-project?prefix=" + "x" * 33,
        "firestore://p?other=1",
    ],
)
def test_settings_in_urls_that_are_refused(url: str) -> None:
    with pytest.raises(ValueError, match="the only setting is a prefix"):
        parse_url(url)


def test_settings_check_firestore_urls() -> None:
    assert Settings(database_url="firestore://my-project").database_url == "firestore://my-project"
    with pytest.raises(ValueError, match="isn't a Firestore URL"):
        Settings(database_url="firestore:")


def test_the_url_chooses_the_storage(monkeypatch: pytest.MonkeyPatch) -> None:
    # The emulator's setting makes the client skip Google sign-in; nothing connects here
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "localhost:1")
    storage = open_storage("firestore://my-project/lokki")

    assert isinstance(storage, FirestoreStorage)
    assert storage.client.project == "my-project"
    assert storage.client._database == "lokki"  # pyright: ignore[reportPrivateUsage]


def test_firestore_needs_no_migrations() -> None:
    migrate("firestore://my-project")  # nothing to do, and no connection made


@pytest.mark.skipif(
    not os.environ.get("FIRESTORE_EMULATOR_HOST"), reason="needs the Firestore emulator"
)
def test_prefixes_keep_servers_apart() -> None:
    project = f"test-{uuid.uuid4().hex[:12]}"

    async def scenario() -> tuple[object, object, list[str]]:
        lokki = FirestoreStorage(f"firestore://{project}")
        other = FirestoreStorage(f"firestore://{project}?prefix=other_")
        try:
            await lokki.create_vault("jocke", 0)
            collections = sorted([c.id async for c in lokki.client.collections()])
            return await lokki.find_vault("jocke"), await other.find_vault("jocke"), collections
        finally:
            await lokki.close()
            await other.close()

    found, elsewhere, collections = asyncio.run(scenario())
    assert found is not None
    assert elsewhere is None
    assert collections == ["lokki_names", "lokki_vaults"]
