"""Settings are checked at start, so a typo fails there and not as a puzzling error later."""

import pytest
from pydantic import ValidationError

from lokki_server.config import Settings


def test_valid_settings() -> None:
    settings = Settings(
        database_url="postgresql+asyncpg://lokki:secret@db.example.com/lokki",
        public_url="https://sync.example.com/",
        cors_origins=["https://lokki.example.com", "http://localhost:5173"],
    )

    assert settings.public_url == "https://sync.example.com"
    assert settings.cors_origins == ["https://lokki.example.com", "http://localhost:5173"]


@pytest.mark.parametrize(
    ("origin", "message"),
    [
        ("lokki.example.com", "needs to start with https://"),
        ("ftp://lokki.example.com", "needs to start with https://"),
        ("https://", "needs to start with https://"),
        ("https://lokki.example.com/", "without a path or a trailing slash"),
        ("https://lokki.example.com/app", "without a path or a trailing slash"),
        ("https://lokki.example.com:99999", "isn't a valid URL"),
    ],
)
def test_cors_origins_must_be_origins(origin: str, message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        Settings(cors_origins=[origin])


def test_public_url_must_be_a_web_address() -> None:
    with pytest.raises(ValidationError, match="needs to start with https://"):
        Settings(public_url="sync.example.com")


def test_database_url_must_be_a_url() -> None:
    with pytest.raises(ValidationError, match="isn't a database URL"):
        Settings(database_url="lokki.db")


def test_settings_come_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOKKI_CORS_ORIGINS", '["https://lokki.example.com/"]')

    with pytest.raises(ValidationError, match="trailing slash"):
        Settings()
