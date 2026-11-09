"""API tokens: made by the server, sent as ``Authorization: Bearer <token>``, stored as hashes."""

import hashlib
import secrets
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from lokki_server import errors
from lokki_server.clock import now_ms
from lokki_server.models import Scope
from lokki_server.storage import Storage
from lokki_server.storage.base import Token as StoredToken

# How often a token's "last used" time is written: not on every request
_TOUCH_EVERY_MS = 60 * 60 * 1000


def new_token() -> str:
    """A new random token: ``lk_`` and 256 random bits."""
    return "lk_" + secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """What the server stores: SHA-256 of the token, hex (random tokens need no salt)."""
    return hashlib.sha256(token.encode()).hexdigest()


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


async def token(
    store: Annotated[Storage, Depends(storage)],
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> StoredToken:
    """The request's token, if it's valid (of either scope); 401 otherwise."""
    sent = credentials.credentials.strip() if credentials is not None else ""
    if not sent:
        raise errors.unauthorized("Send an API token: Authorization: Bearer <token>.")
    found = await store.find_token(hash_token(sent))
    if found is None:
        raise errors.unauthorized()
    now = now_ms()
    if found.last_used is None or now - found.last_used >= _TOUCH_EVERY_MS:
        await store.touch_token(found.token_id, now)
    # `last_used` stays as it was before this request; nothing after this check reads it
    return found


async def write_token(found: Annotated[StoredToken, Depends(token)]) -> StoredToken:
    """The request's token, if it may write; 403 otherwise."""
    if found.scope != Scope.WRITE:
        raise errors.forbidden()
    return found


# For endpoints: `token: Token` needs a valid token, `token: WriteToken` one that may write
Token = Annotated[StoredToken, Depends(token)]
WriteToken = Annotated[StoredToken, Depends(write_token)]
