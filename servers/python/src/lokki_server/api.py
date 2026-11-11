"""The HTTP API, version 1 (docs/sync-protocol.md, section 5.3)."""

import json
import secrets
from typing import Annotated, assert_never

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import JsonValue

from lokki_server import __version__, errors
from lokki_server.auth import Token, WriteToken, hash_token, new_token, storage
from lokki_server.clock import iso, now_ms
from lokki_server.config import Settings
from lokki_server.errors import DEFAULT, documented
from lokki_server.models import (
    Head,
    Info,
    InfoLimits,
    KeyringPut,
    KeyringVersion,
    Mark,
    Pull,
    Push,
    RowOut,
    Scope,
    TestVaultRequest,
    TestVaultTokens,
    Vault,
)
from lokki_server.storage import Storage
from lokki_server.storage.base import NameTaken, Outcome

router = APIRouter(
    prefix="/v1",
    responses=DEFAULT,
)
test_router = APIRouter(
    prefix="/v1/test",
    tags=["test mode"],
    responses=DEFAULT,
)

# Examples of the errors each endpoint can give, for the API docs
_INVALID = errors.invalid_request("rows.0.key: String should match pattern '^[A-Za-z0-9_-]{22}$'")
_SIGNED_IN = documented(errors.unauthorized())
_WRITING = documented(
    errors.unauthorized(),
    errors.forbidden(),
)

Store = Annotated[Storage, Depends(storage)]


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
async def info(request: Request, config: Config) -> Info:
    """The server's name, version, ID, API versions and limits. Needs no token (protocol 5.3)."""
    limits = config.limits
    return Info(
        version=__version__,
        id=request.app.state.server_id,
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
async def vault(token: Token, store: Store) -> Vault:
    """
    The keyring (null for a new vault) and the vault's counters. A device reads this first, to
    unlock the vault and to see whether there's anything new (protocol 5.3, 7.2).
    """
    status = await store.vault(token.vault_id)
    keyring: dict[str, JsonValue] | None = (
        json.loads(status.keyring) if status.keyring is not None else None
    )
    return Vault(
        keyring=keyring,
        keyring_version=status.keyring_version,
        head=status.head,
        mark=status.mark,
        changed=iso(status.changed),
    )


@router.delete(
    "/vault",
    status_code=204,
    tags=["vault"],
    summary="Delete the vault and its tokens",
    responses={204: {"description": "Deleted"}, **_WRITING},
)
async def delete_vault(token: WriteToken, store: Store) -> Response:
    """
    Deletes every row, the keyring and all the vault's tokens, including the one used. This can't
    be undone; devices keep their own copies (protocol 5.3).
    """
    await store.delete_vault(token.vault_id)
    return Response(status_code=204)


@router.put(
    "/vault/keyring",
    tags=["vault"],
    summary="Replace the keyring",
    response_description="Written",
    responses=documented(
        _INVALID,
        errors.unauthorized(),
        errors.forbidden(),
        errors.keyring_behind(4),
        errors.different_vault(4),
        errors.too_large("A keyring can be at most 16384 bytes."),
    ),
)
async def put_keyring(
    body: KeyringPut,
    token: WriteToken,
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
        raise errors.too_large(f"A keyring can be at most {config.limits.keyring_bytes} bytes.")
    result = await store.put_keyring(
        token.vault_id,
        body.base,
        text,
        body.keyring.vault,
        now_ms(),
    )
    match result.outcome:
        case Outcome.OK:
            return KeyringVersion(keyring_version=result.version)
        case Outcome.DIFFERENT_VAULT:
            raise errors.different_vault(result.version)
        case Outcome.BEHIND:
            raise errors.keyring_behind(result.version)
        case _:
            assert_never(result.outcome)


@router.get(
    "/vault/rows",
    tags=["vault"],
    summary="Pull rows",
    response_description="The rows, and where to continue",
    responses=documented(
        errors.invalid_request("since: Input should be greater than or equal to 0"),
        errors.unauthorized(),
        errors.history_changed(),
    ),
)
async def pull(
    token: Token,
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
    mark: Annotated[
        Mark | None,
        Query(
            description="The `mark` that came with row `at`: by default `since`, as `cursor` and "
            "`mark` of the last pull. If that row wasn't written by the push with this mark, the "
            "vault's history changed: `409 history_changed`. Leave it out to pull without "
            "checking.",
            examples=["Xq3vT0bK9mWc1sPa"],
        ),
    ] = None,
    at: Annotated[
        int | None,
        Query(
            ge=1,
            description="Which row `mark` is for, if not `since`: e.g. the vault's `head` and "
            "`mark` when the device started pulling everything, while its pages have no marks "
            "of their own (protocol 7.4)",
            examples=[16977],
        ),
    ] = None,
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
    `since` and `mark` as `mark` (protocol 5.3, 7.2, 7.4).
    """
    if at is not None and mark is None:
        raise errors.invalid_request("at: Only with a mark")
    if mark is not None and at is None and since == 0:
        raise errors.invalid_request("mark: Only with a since above 0, or an at")
    most = config.limits.pull if limit is None else min(limit, config.limits.pull)
    result = await store.pull(
        token.vault_id,
        since,
        most,
        None if mark is None else since if at is None else at,
    )
    # The mark comes from the same snapshot as the rows, so they're checked together
    if mark is not None and result.at_mark != mark:
        raise errors.history_changed()
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
        mark=result.mark,
    )


@router.post(
    "/vault/rows",
    tags=["vault"],
    summary="Push rows",
    response_description="Written",
    responses=documented(
        _INVALID,
        errors.unauthorized(),
        errors.forbidden(),
        errors.behind(1050),
        errors.too_large("A push can have at most 500 rows."),
    ),
)
async def push(
    body: Push,
    token: WriteToken,
    store: Store,
    config: Config,
) -> Head:
    """
    Adds the rows, replacing any with the same key, all or none, and only if `base` is still the
    vault's `head` and `mark` the latest push's. Otherwise nothing is written: `409 behind`, so pull
    first (protocol 5.3, 7.3, 7.4).
    """
    limits = config.limits
    if len(body.rows) > limits.push:
        raise errors.too_large(f"A push can have at most {limits.push} rows.")
    if any(len(r.data.encode()) > limits.row_bytes for r in body.rows):
        raise errors.too_large(f"A row's data can be at most {limits.row_bytes} bytes.")
    keys = [r.key for r in body.rows]
    if len(set(keys)) != len(keys):
        raise errors.invalid_request("A push can't contain the same key twice.")
    mark = new_mark()
    result = await store.push(
        token.vault_id,
        body.base,
        body.mark,
        [(r.key, r.data) for r in body.rows],
        mark,
        config.history,
        now_ms(),
    )
    if result.outcome is Outcome.BEHIND:
        raise errors.behind(result.version)
    return Head(
        head=result.version,
        mark=mark,
    )


def new_mark() -> str:
    """A push's mark: random, so another history can't come up with the same one (protocol 7.4)."""
    return secrets.token_urlsafe(12)


@test_router.post(
    "/vaults",
    status_code=201,
    summary="Create a test vault",
    response_description="Created",
    responses=documented(
        errors.invalid_request(
            "name: String should match pattern '^[A-Za-z0-9][A-Za-z0-9._+@-]{0,63}$'"
        ),
        errors.name_taken("conformance"),
    ),
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
        raise errors.name_taken(name) from None
    tokens = {scope: new_token() for scope in Scope}
    for scope, token in tokens.items():
        await store.add_token(
            vault_id,
            scope,  # each test token is labelled with its scope
            hash_token(token),
            scope,
            now,
        )
    return TestVaultTokens(
        name=name,
        write=tokens[Scope.WRITE],
        read=tokens[Scope.READ],
    )
