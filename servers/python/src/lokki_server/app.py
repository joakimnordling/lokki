"""The FastAPI application."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from lokki_server import __version__, errors
from lokki_server.api import router, test_router
from lokki_server.config import Settings
from lokki_server.storage import open_storage


def create_app(settings: Settings | None = None) -> FastAPI:
    """
    The app for these settings (read from the environment if not given).

    The database must already be migrated (``lokki-server migrate``; ``serve`` does it first).
    """
    config = settings if settings is not None else Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        storage = open_storage(config.database_url)
        app.state.storage = storage
        try:
            await storage.server_id()  # made on first start
            yield
        finally:
            await storage.close()

    app = FastAPI(
        title="Lokki sync server",
        version=__version__,
        lifespan=lifespan,
        redoc_url=None,
    )
    app.state.settings = config
    errors.install(app)
    app.include_router(router)
    if config.test_mode:
        app.include_router(test_router)
    if config.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=config.cors_origins,
            allow_methods=["GET", "POST", "PUT", "DELETE"],
            allow_headers=["Authorization", "Content-Type"],
            allow_credentials=False,
            max_age=600,
        )
    return app
