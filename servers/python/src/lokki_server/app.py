"""The FastAPI application."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi_standalone_docs import StandaloneDocs  # pyright: ignore[reportMissingTypeStubs] (no py.typed)

from lokki_server import __version__, errors
from lokki_server.api import router, test_router
from lokki_server.config import Settings
from lokki_server.storage import open_storage

_PROTOCOL = "https://github.com/joakimnordling/lokki/blob/main/docs/sync-protocol.md"
_DESCRIPTION = f"""
The server side of Lokki's sync, as described in [the sync protocol]({_PROTOCOL}). Devices
encrypt everything before sending it, so the server only keeps rows it can't read, and a
counter that tells devices what's new.

Every endpoint except `/v1/info` needs an API token, from `lokki-server token add`, and acts on
the vault that token belongs to. To try them here, choose **Authorize** and paste a token.

Errors are always `{{"error": "<code>", "message": "…"}}`, with `400` for a request that isn't
valid (never `422`).
"""
_TAGS = [
    {"name": "server", "description": "About the server itself"},
    {"name": "vault", "description": "The vault the token belongs to: its keyring and rows"},
]
# Listed, like its endpoint, only in test mode
_TEST_TAG = {
    "name": "test mode",
    "description": "Only when `LOKKI_TEST_MODE` is on, never in production",
}


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
        summary="Stores end-to-end encrypted rows for Lokki's devices. It can't read any of them.",
        description=_DESCRIPTION,
        openapi_tags=[*_TAGS, _TEST_TAG] if config.test_mode else _TAGS,
        lifespan=lifespan,
        docs_url="/docs" if config.docs else None,
        redoc_url="/redoc" if config.docs else None,
        openapi_url="/openapi.json" if config.docs else None,
    )
    if config.docs:
        StandaloneDocs(app=app)  # serves Swagger UI's and ReDoc's files itself, not from CDNs
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
