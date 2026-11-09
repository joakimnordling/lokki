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
from lokki_server.errors import OTHER_ERRORS, ApiError, documented
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

router = APIRouter(
    prefix="/v1",
    responses=OTHER_ERRORS,
)
test_router = APIRouter(
    prefix="/v1/test",
    tags=["test mode"],
    responses=OTHER_ERRORS,
)

# What every endpoint that needs a token can answer
_SIGNED_IN = documented("unauthorized")
_WRITING = documented("unauthorized", "forbidden")

Store = Annotated[Storage, Depends(storage)]
Reader = Annotated[Caller, Depends(caller)]
Writer = Annotated[Caller, Depends(writer)]


def settings(request: Request) -> Settings:
    """The app's settings."""
    found: Settings = request.app.state.settings
    return found


Config = Annotated[Settings, Depends(settings)]


@router.get(
    "/info",
    tags=["server"],
    summary="What this server is",
    response_description="The server",
)
async def info(store: Store, config: Config) -> Info:
    """The server's name, version, ID, API versions and limits. Needs no token (protocol 5.3)."""
    limits = config.limits
    return Info(
        version=__version__,
        id=await store.server_id(),
        api=[1],
        limits=InfoLimits(
            pull=limits.pull,
            push=limits.push,
            row_bytes=limits.row_bytes,
        ),
    )


@router.get(
    "/vault",
    tags=["vault"],
    summary="Read the vault's keyring and status",
    response_description="The vault",
    responses=_SIGNED_IN,
)
async def vault(who: Reader, store: Store) -> Vault:
    """
    The keyring (null for a new vault) and the vault's counters. A device reads this first, to
    unlock the vault and to see whether there's anything new (protocol 5.3, 7.2).
    """
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


@router.delete(
    "/vault",
    status_code=204,
    tags=["vault"],
    summary="Delete the vault and its tokens",
    responses={204: {"description": "Deleted"}, **_WRITING},
)
async def delete_vault(who: Writer, store: Store) -> Response:
    """
    Deletes every row, the keyring and all the vault's tokens, including the one used. This can't
    be undone; devices keep their own copies (protocol 5.3).
    """
    await store.delete_vault(who.vault_id)
    return Response(status_code=204)


@router.put(
    "/vault/keyring",
    tags=["vault"],
    summary="Replace the keyring",
    response_description="Written",
    responses=documented(
        "invalid_request",
        "unauthorized",
        "forbidden",
        "keyring_behind",
        "different_vault",
        "too_large",
    ),
)
async def put_keyring(
    body: KeyringPut,
    who: Writer,
    store: Store,
    config: Config,
) -> KeyringVersion:
    """
    Written only if `base` is the current `keyring_version`, and only for the same vault:
    otherwise `409`, and the device reads the vault again (protocol 4.4, 5.3).
    """
    text = json.dumps(
        body.keyring.model_dump(mode="json"),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    if len(text.encode()) > config.limits.keyring_bytes:
        raise ApiError(
            413,
            "too_large",
            f"A keyring can be at most {config.limits.keyring_bytes} bytes.",
        )
    result = await store.put_keyring(
        who.vault_id,
        body.base,
        text,
        body.keyring.vault,
        now_ms(),
    )
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


@router.get(
    "/vault/rows",
    tags=["vault"],
    summary="Pull rows",
    response_description="The rows, and where to continue",
    responses=documented("invalid_request", "unauthorized"),
)
async def pull(
    who: Reader,
    store: Store,
    config: Config,
    since: Annotated[
        int,
        Query(
            ge=0,
            description="The `cursor` from the last pull; 0 for everything",
            examples=[1040],
        ),
    ] = 0,
    limit: Annotated[
        int | None,
        Query(
            ge=1,
            description="Most rows to return; at most, and by default, `limits.pull`",
        ),
    ] = None,
) -> Pull:
    """
    Rows written after `since`, oldest first. While `more` is true, continue with `cursor` as
    `since` (protocol 5.3, 7.2).
    """
    most = config.limits.pull if limit is None else min(limit, config.limits.pull)
    result = await store.pull(
        who.vault_id,
        since,
        most,
    )
    return Pull(
        rows=[
            RowOut(
                key=r.key,
                seq=r.seq,
                data=r.data,
            )
            for r in result.rows
        ],
        cursor=result.cursor,
        more=result.more,
        head=result.head,
    )


@router.post(
    "/vault/rows",
    tags=["vault"],
    summary="Push rows",
    response_description="Written",
    responses=documented(
        "invalid_request",
        "unauthorized",
        "forbidden",
        "behind",
        "too_large",
    ),
)
async def push(
    body: Push,
    who: Writer,
    store: Store,
    config: Config,
) -> Head:
    """
    Adds the rows, replacing any with the same key, all or none, and only if `base` is still the
    vault's `head`. Otherwise nothing is written: `409 behind`, so pull first (protocol 5.3, 7.3).
    """
    limits = config.limits
    if len(body.rows) > limits.push:
        raise ApiError(
            413,
            "too_large",
            f"A push can have at most {limits.push} rows.",
        )
    if any(len(r.data.encode()) > limits.row_bytes for r in body.rows):
        raise ApiError(
            413,
            "too_large",
            f"A row's data can be at most {limits.row_bytes} bytes.",
        )
    keys = [r.key for r in body.rows]
    if len(set(keys)) != len(keys):
        raise ApiError(
            400,
            "invalid_request",
            "A push can't contain the same key twice.",
        )
    result = await store.push(
        who.vault_id,
        body.base,
        [(r.key, r.data) for r in body.rows],
        now_ms(),
    )
    if result.outcome is Outcome.BEHIND:
        raise ApiError(
            409,
            "behind",
            "Pull first: the vault has changed.",
            head=result.version,
        )
    return Head(head=result.version)


@test_router.post(
    "/vaults",
    status_code=201,
    summary="Create a test vault",
    response_description="Created",
    responses=documented("invalid_request", "name_taken"),
)
async def create_test_vault(body: TestVaultRequest, store: Store) -> TestVaultTokens:
    """
    Only in test mode, never in production: a new, empty vault with a token of each scope, so a
    test suite can check any server from the outside (protocol 5.5).
    """
    now = now_ms()
    name = body.name or f"test-{secrets.token_hex(6)}"
    try:
        vault_id = await store.create_vault(name, now)
    except NameTaken:
        raise ApiError(
            409,
            "name_taken",
            f"There's a vault called {name} already.",
        ) from None
    tokens = {"write": new_token(), "read": new_token()}
    for scope, token in tokens.items():
        await store.add_token(
            vault_id,
            scope,
            hash_token(token),
            "write" if scope == "write" else "read",
            now,
        )
    return TestVaultTokens(
        name=name,
        **tokens,
    )
