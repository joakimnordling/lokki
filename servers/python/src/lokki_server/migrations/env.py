"""Alembic environment: runs migrations on the async engine for the configured URL."""

import asyncio

from alembic import context
from sqlalchemy import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from lokki_server.storage.schema import metadata
from lokki_server.storage.sql import engine_url


def _run(connection: Connection) -> None:
    # batch mode: SQLite can't alter tables in place, Alembic copies them instead
    context.configure(connection=connection, target_metadata=metadata, render_as_batch=True)
    with context.begin_transaction():
        context.run_migrations()


async def _run_async(url: str) -> None:
    engine = create_async_engine(engine_url(url))
    try:
        async with engine.connect() as connection:
            await connection.run_sync(_run)
    finally:
        await engine.dispose()


if context.is_offline_mode():
    raise SystemExit("Offline (SQL script) migrations aren't supported.")

asyncio.run(_run_async(context.config.attributes["url"]))
