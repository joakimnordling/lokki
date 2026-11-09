"""The HTTP API, version 1 (docs/sync-protocol.md, section 5.3)."""

import json
import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import JsonValue

from lokki_server import __version__
from lokki_server.auth import Caller, caller, hash_token, new_token, storage, writer
from lokki_server.clock import iso, now_ms
from lokki_server.config import Settings
from lokki_server.errors import ApiError
from lokki_server.models import (
    Head,
    Info,
    InfoLimits,
    KeyringPut,
    KeyringVersion,
    Pull,
    Push,
    RowOut,
    TestVaultRequest,
    TestVaultTokens,
    Vault,
)
from lokki_server.storage import Storage
from lokki_server.storage.base import NameTaken, Outcome

router = APIRouter(prefix="/v1")
test_router = APIRouter(prefix="/v1/test")

Store = Annotated[Storage, Depends(storage)]
Reader = Annotated[Caller, Depends(caller)]
Writer = Annotated[Caller, Depends(writer)]


def settings(request: Request) -> Settings:
    """The app's settings."""
    found: Settings = request.app.state.settings
    return found


Config = Annotated[Settings, Depends(settings)]


@router.get("/info")
async def info(store: Store, config: Config) -> Info:
    """The server's name, version, ID, API versions and limits. No sign-in needed."""
    limits = config.limits
    return Info(
        version=__version__,
        id=await store.server_id(),
        api=[1],
        limits=InfoLimits(pull=limits.pull, push=limits.push, row_bytes=limits.row_bytes),
    )


@router.get("/vault")
async def vault(who: Reader, store: Store) -> Vault:
    """The vault: its keyring (or null) and status."""
    status = await store.vault(who.vault_id)
    keyring: dict[str, JsonValue] | None = (
        json.loads(status.keyring) if status.keyring is not None else None
    )
    return Vault(
        keyring=keyring,
        keyring_version=status.keyring_version,
        head=status.head,
        rows=status.rows,
        changed=iso(status.changed),
    )


@router.delete("/vault", status_code=204)
async def delete_vault(who: Writer, store: Store) -> Response:
    """Delete the vault, including every token."""
    await store.delete_vault(who.vault_id)
    return Response(status_code=204)


@router.put("/vault/keyring")
async def put_keyring(
    body: KeyringPut, who: Writer, store: Store, config: Config
) -> KeyringVersion:
    """Replace the keyring, if `base` is the current keyring version."""
    text = json.dumps(
        body.keyring.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":")
    )
    if len(text.encode()) > config.limits.keyring_bytes:
        raise ApiError(
            413, "too_large", f"A keyring can be at most {config.limits.keyring_bytes} bytes."
        )
    result = await store.put_keyring(who.vault_id, body.base, text, body.keyring.vault, now_ms())
    match result.outcome:
        case Outcome.OK:
            return KeyringVersion(keyring_version=result.version)
        case Outcome.DIFFERENT_VAULT:
            raise ApiError(
                409,
                "different_vault",
                "This server holds a different vault.",
                keyring_version=result.version,
            )
        case Outcome.BEHIND:
            raise ApiError(
                409,
                "behind",
                "The keyring has changed; read the vault again.",
                keyring_version=result.version,
            )


@router.get("/vault/rows")
async def pull(
    who: Reader,
    store: Store,
    config: Config,
    since: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int | None, Query(ge=1)] = None,
) -> Pull:
    """Rows written after `since`, oldest first. Continue from `cursor` while `more` is true."""
    most = config.limits.pull if limit is None else min(limit, config.limits.pull)
    result = await store.pull(who.vault_id, since, most)
    return Pull(
        rows=[RowOut(key=r.key, seq=r.seq, data=r.data) for r in result.rows],
        cursor=result.cursor,
        more=result.more,
        head=result.head,
    )


@router.post("/vault/rows")
async def push(body: Push, who: Writer, store: Store, config: Config) -> Head:
    """Add or replace rows, all or none, if `base` is the current head."""
    limits = config.limits
    if len(body.rows) > limits.push:
        raise ApiError(413, "too_large", f"A push can have at most {limits.push} rows.")
    if any(len(r.data.encode()) > limits.row_bytes for r in body.rows):
        raise ApiError(413, "too_large", f"A row's data can be at most {limits.row_bytes} bytes.")
    keys = [r.key for r in body.rows]
    if len(set(keys)) != len(keys):
        raise ApiError(400, "invalid_request", "A push can't contain the same key twice.")
    result = await store.push(
        who.vault_id, body.base, [(r.key, r.data) for r in body.rows], now_ms()
    )
    if result.outcome is Outcome.BEHIND:
        raise ApiError(409, "behind", "Pull first: the vault has changed.", head=result.version)
    return Head(head=result.version)


@test_router.post("/vaults", status_code=201)
async def create_test_vault(body: TestVaultRequest, store: Store) -> TestVaultTokens:
    """Test mode only: a new, empty vault with a write and a read token."""
    now = now_ms()
    name = body.name or f"test-{secrets.token_hex(6)}"
    try:
        vault_id = await store.create_vault(name, now)
    except NameTaken:
        raise ApiError(409, "name_taken", f"There's a vault called {name} already.") from None
    tokens = {"write": new_token(), "read": new_token()}
    for scope, token in tokens.items():
        await store.add_token(
            vault_id, scope, hash_token(token), "write" if scope == "write" else "read", now
        )
    return TestVaultTokens(name=name, **tokens)
