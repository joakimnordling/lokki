"""Storage: the interface, and opening and migrating a database by its URL."""

from alembic import command
from alembic.config import Config

from lokki_server.config import Pool
from lokki_server.storage.base import Storage
from lokki_server.storage.sql import SqlStorage

__all__ = ["Storage", "migrate", "open_storage"]


def open_storage(url: str, pool: Pool | None = None) -> Storage:
    """
    The storage for a database URL: firestore://PROJECT[/DATABASE], or an SQLAlchemy URL. `pool`
    is for PostgreSQL; the default is the settings' default.
    """
    if url.startswith("firestore:"):
        # imported only when used: Firestore's libraries are an optional extra
        from lokki_server.storage.firestore import FirestoreStorage

        return FirestoreStorage(url)
    return SqlStorage(
        url,
        pool,
    )


def migrate(url: str, revision: str = "head") -> None:
    """
    Bring the database's tables up to date (Alembic ``upgrade``).

    Synchronous: call it before starting an event loop, not from inside one. Firestore has no
    tables, so there's nothing to do for it.
    """
    if url.startswith("firestore:"):
        return
    config = Config()
    config.set_main_option("script_location", "lokki_server:migrations")
    config.attributes["url"] = url
    command.upgrade(config, revision)
