"""Settings, read from ``LOKKI_*`` environment variables (and an optional ``.env`` file)."""

from typing import Annotated
from urllib.parse import SplitResult, urlsplit

from pydantic import AfterValidator, BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError

from lokki_server.storage.sql import engine_url


def _web_address(value: str) -> SplitResult:
    """The URL's parts; ValueError unless it's http(s) with a host."""
    try:
        parts = urlsplit(value)
        parts.port  # noqa: B018 (raises ValueError for an invalid port)
    except ValueError:
        raise ValueError(f"{value!r} isn't a valid URL.") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"{value!r} needs to start with https:// (or http://) and a host name.")
    return parts


def _check_public_url(value: str) -> str:
    _web_address(value)
    return value.rstrip("/")


def _check_origin(value: str) -> str:
    # Browsers send the origin exactly like this, and CORS compares the text: no path, no slash
    parts = _web_address(value)
    if parts.path or parts.query or parts.fragment or parts.username or parts.password:
        raise ValueError(
            f"{value!r} isn't an origin: give only the scheme, host and port, without a path or "
            "a trailing slash, e.g. https://lokki.example.com."
        )
    return value


def _check_database_url(value: str) -> str:
    if value.startswith("firestore:"):
        from lokki_server.storage.firestore import parse_url

        parse_url(value)
        return value
    try:
        make_url(engine_url(value))
    except ArgumentError:
        raise ValueError(
            f"{value!r} isn't a database URL, e.g. sqlite+aiosqlite:///lokki.db."
        ) from None
    return value


PublicUrl = Annotated[str, AfterValidator(_check_public_url)]
Origin = Annotated[str, AfterValidator(_check_origin)]
DatabaseUrl = Annotated[str, AfterValidator(_check_database_url)]


class Limits(BaseModel):
    """Limits the server announces in ``GET /v1/info`` and enforces."""

    pull: int = Field(
        default=1000,
        ge=1,
        description="Most rows returned by one pull",
    )
    push: int = Field(
        default=500,
        ge=1,
        description="Most rows accepted in one push",
    )
    row_bytes: int = Field(
        default=4096,
        ge=64,
        description="Largest accepted row `data`, in bytes",
    )
    keyring_bytes: int = Field(
        default=16384,
        ge=1024,
        description="Largest accepted keyring, in bytes",
    )


class Settings(BaseSettings):
    """Server settings."""

    model_config = SettingsConfigDict(
        env_prefix="LOKKI_",
        env_file=".env",
        env_nested_delimiter="__",
        extra="ignore",
    )

    database_url: DatabaseUrl = Field(
        default="sqlite+aiosqlite:///lokki.db",
        description="SQLAlchemy URL of the database, with an async driver",
    )
    public_url: PublicUrl = Field(
        default="http://localhost:8000",
        description="The URL devices use to reach this server; printed with new tokens",
    )
    cors_origins: list[Origin] = Field(
        default_factory=list,
        description="Origins the web app is served from, e.g. https://lokki.example.com",
    )
    docs: bool = Field(
        default=True,
        description="Serves the API docs: Swagger UI at /docs, ReDoc at /redoc, /openapi.json",
    )
    test_mode: bool = Field(
        default=False,
        description="Enables POST /v1/test/vaults for the conformance tests; never in production",
    )
    limits: Limits = Field(default_factory=Limits)
