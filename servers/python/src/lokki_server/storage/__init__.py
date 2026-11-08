"""Storage: the interface, and opening and migrating a database by its URL."""

from alembic import command
from alembic.config import Config

from lokki_server.storage.base import Storage
from lokki_server.storage.sql import SqlStorage

__all__ = ["Storage", "migrate", "open_storage"]


def open_storage(url: str) -> Storage:
    """The storage for a database URL."""
    return SqlStorage(url)


def migrate(url: str, revision: str = "head") -> None:
    """
    Bring the database's tables up to date (Alembic ``upgrade``).

    Synchronous: call it before starting an event loop, not from inside one.
    """
    config = Config()
    config.set_main_option("script_location", "lokki_server:migrations")
    config.attributes["url"] = url
    command.upgrade(config, revision)
