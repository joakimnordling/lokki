"""API tokens: made by the server, sent as ``Authorization: Bearer <token>``, stored as hashes."""

import hashlib
import secrets
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from lokki_server.clock import now_ms
from lokki_server.errors import ApiError
from lokki_server.models import Scope
from lokki_server.storage import Storage

# How often a token's "last used" time is written: not on every request
_TOUCH_EVERY_MS = 60 * 60 * 1000


def new_token() -> str:
    """A new random token: ``lk_`` and 256 random bits."""
    return "lk_" + secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """What the server stores: SHA-256 of the token, hex (random tokens need no salt)."""
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass(
    frozen=True,
    slots=True,
)
class Caller:
    """The vault a request acts on (its internal number), and what the token may do."""

    vault_id: int
    scope: Scope


def storage(request: Request) -> Storage:
    """The app's storage."""
    found: Storage = request.app.state.storage
    return found


# Reads `Authorization: Bearer <token>`, and tells the API docs that endpoints need a token (their
# "Authorize" button). Missing tokens get the protocol's error below, not FastAPI's.
_bearer = HTTPBearer(
    auto_error=False,
    scheme_name="Token",
    description="An API token from `lokki-server token add`, e.g. `lk_6Yq3kM0p…`",
)


async def caller(
    store: Annotated[Storage, Depends(storage)],
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> Caller:
    """The caller, from a valid token; 401 otherwise."""
    token = credentials.credentials.strip() if credentials is not None else ""
    if not token:
        raise ApiError(
            401,
            "unauthorized",
            "Send an API token: Authorization: Bearer <token>.",
        )
    found = await store.find_token(hash_token(token))
    if found is None:
        raise ApiError(
            401,
            "unauthorized",
            "This token isn't valid on this server.",
        )
    now = now_ms()
    if found.last_used is None or now - found.last_used >= _TOUCH_EVERY_MS:
        await store.touch_token(found.token_id, now)
    return Caller(
        vault_id=found.vault_id,
        scope=found.scope,
    )


async def writer(found: Annotated[Caller, Depends(caller)]) -> Caller:
    """The caller, if their token may write; 403 otherwise."""
    if found.scope != "write":
        raise ApiError(
            403,
            "forbidden",
            "This token can only read.",
        )
    return found
