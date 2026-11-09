"""Settings, read from ``LOKKI_*`` environment variables (and an optional ``.env`` file)."""

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Limits(BaseModel):
    """Limits the server announces in ``GET /v1/info`` and enforces."""

    pull: int = Field(default=1000, ge=1, description="Most rows returned by one pull")
    push: int = Field(default=500, ge=1, description="Most rows accepted in one push")
    row_bytes: int = Field(default=4096, ge=64, description="Largest accepted row `data`, in bytes")
    keyring_bytes: int = Field(
        default=16384, ge=1024, description="Largest accepted keyring, in bytes"
    )


class Settings(BaseSettings):
    """Server settings."""

    model_config = SettingsConfigDict(
        env_prefix="LOKKI_", env_file=".env", env_nested_delimiter="__", extra="ignore"
    )

    database_url: str = Field(
        default="sqlite+aiosqlite:///lokki.db",
        description="SQLAlchemy URL of the database, with an async driver",
    )
    public_url: str = Field(
        default="http://localhost:8000",
        description="The URL devices use to reach this server; printed with new tokens",
    )
    cors_origins: list[str] = Field(
        default_factory=list,
        description="Origins the web app is served from, e.g. https://lokki.example.com",
    )
    test_mode: bool = Field(
        default=False,
        description="Enables POST /v1/test/vaults for the conformance tests; never in production",
    )
    limits: Limits = Field(default_factory=Limits)
