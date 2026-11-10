"""Choosing Firestore by URL. Its storage runs every API test too, against the emulator in CI."""

import pytest

from lokki_server.config import Settings
from lokki_server.storage import migrate, open_storage
from lokki_server.storage.firestore import FirestoreStorage, parse_url


@pytest.mark.parametrize(
    ("url", "project", "database"),
    [
        ("firestore://my-project", "my-project", "(default)"),
        ("firestore://my-project/", "my-project", "(default)"),
        ("firestore://my-project/lokki", "my-project", "lokki"),
    ],
)
def test_urls(url: str, project: str, database: str) -> None:
    assert parse_url(url) == (project, database)


@pytest.mark.parametrize("url", ["firestore:", "firestore:///lokki", "sqlite:///lokki.db"])
def test_urls_that_are_refused(url: str) -> None:
    with pytest.raises(ValueError, match="isn't a Firestore URL"):
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
