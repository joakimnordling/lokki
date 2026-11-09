"""The ``lokki-server`` command: run the server and manage vaults and tokens."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Annotated, NoReturn

import typer
import uvicorn

from lokki_server._sync import async_to_sync
from lokki_server.app import create_app
from lokki_server.auth import hash_token, new_token
from lokki_server.clock import iso, now_ms
from lokki_server.config import Settings
from lokki_server.models import Scope
from lokki_server.names import check_label, check_vault_name
from lokki_server.storage import Storage, migrate, open_storage
from lokki_server.storage.base import NameTaken

app = typer.Typer(
    help="Lokki sync server. Settings come from LOKKI_* environment variables.",
    no_args_is_help=True,
    add_completion=False,
)

ScopeOption = Annotated[Scope, typer.Option(help="write (default) or read")]


@asynccontextmanager
async def _storage(settings: Settings) -> AsyncGenerator[Storage]:
    storage = open_storage(settings.database_url)
    try:
        yield storage
    finally:
        await storage.close()


@app.command()
def serve(
    host: Annotated[str, typer.Option(help="Address to listen on")] = "127.0.0.1",
    port: Annotated[
        int,
        typer.Option(
            envvar="PORT",
            help="Port (also from $PORT)",
        ),
    ] = 8000,
    migrate_first: Annotated[
        bool,
        typer.Option(
            "--migrate/--no-migrate",
            help="Update the database's tables first",
        ),
    ] = True,
) -> None:
    """Run the server."""
    settings = Settings()
    if migrate_first:
        migrate(settings.database_url)
    uvicorn.run(
        create_app(settings),
        host=host,
        port=port,
        proxy_headers=True,
    )


@app.command("migrate")
def migrate_command() -> None:
    """Update the database's tables to this version of the server."""
    migrate(Settings().database_url)
    typer.echo("The database is up to date.")


vault_app = typer.Typer(
    help="Vaults: one per person, holding their logs.",
    no_args_is_help=True,
)
token_app = typer.Typer(
    help="Tokens: what devices sign in with, e.g. one per device.",
    no_args_is_help=True,
)
app.add_typer(
    vault_app,
    name="vault",
)
app.add_typer(
    token_app,
    name="token",
)


def _vault_name(value: str) -> str:
    try:
        return check_vault_name(value)
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None


def _label(value: str) -> str:
    try:
        return check_label(value)
    except ValueError as e:
        raise typer.BadParameter(str(e)) from None


VaultName = Annotated[
    str,
    typer.Argument(
        help="The vault's name",
        callback=_vault_name,
    ),
]
Label = Annotated[str, typer.Argument(help="The token's label, e.g. the device's name")]


def _fail(message: str) -> NoReturn:
    typer.echo(
        message,
        err=True,
    )
    raise typer.Exit(1)


async def _find(storage: Storage, name: str) -> int:
    found = await storage.find_vault(name)
    if found is None:
        _fail(f"There's no vault called {name}. See them with: lokki-server vault list")
    return found


@vault_app.command("add")
@async_to_sync
async def vault_add(name: VaultName) -> None:
    """Create an empty vault. Then add a token for each device."""
    async with _storage(Settings()) as storage:
        try:
            await storage.create_vault(name, now_ms())
        except NameTaken:
            _fail(f"There's a vault called {name} already.")
    typer.echo(f"Vault {name} created. Add a token for each device:")
    typer.echo(f'  lokki-server token add {name} "LABEL"')


@vault_app.command("list")
@async_to_sync
async def vault_list() -> None:
    """List the vaults."""
    async with _storage(Settings()) as storage:
        found = await storage.list_vaults()
    if not found:
        typer.echo("No vaults yet. Create one with: lokki-server vault add NAME")
    width = max(
        (len(v.name) for v in found),
        default=0,
    )
    for v in found:
        typer.echo(
            f"{v.name:<{width}}  rows: {v.rows}  head: {v.head}  tokens: {v.tokens}"
            f"  created: {iso(v.created)}"
        )


@vault_app.command("delete")
@async_to_sync
async def vault_delete(
    name: VaultName,
    yes: Annotated[
        bool,
        typer.Option(
            "--yes",
            help="Don't ask for confirmation",
        ),
    ] = False,
) -> None:
    """Delete a vault with everything in it and all its tokens. This can't be undone."""
    async with _storage(Settings()) as storage:
        vault_id = await _find(storage, name)
        if not yes:
            typer.confirm(
                f"Delete the vault {name}, everything in it and its tokens?",
                abort=True,
            )
        await storage.delete_vault(vault_id)
    typer.echo(f"Vault {name} deleted.")


@token_app.command("add")
@async_to_sync
async def token_add(
    vault: VaultName,
    label: Annotated[
        str,
        typer.Argument(
            help="A label, e.g. the device's name",
            callback=_label,
        ),
    ],
    scope: ScopeOption = "write",
) -> None:
    """Add a token to a vault and print the URL and token to enter in the app."""
    settings = Settings()
    async with _storage(settings) as storage:
        vault_id = await _find(storage, vault)
        token = new_token()
        try:
            await storage.add_token(
                vault_id,
                label,
                hash_token(token),
                scope,
                now_ms(),
            )
        except NameTaken:
            _fail(f"The vault {vault} has a token called {label} already.")
    typer.echo(f"Token {label} ({scope}) for the vault {vault}. Enter these in the app:")
    typer.echo(f"URL:    {settings.public_url}")
    typer.echo(f"Token:  {token}    (shown only now)")


@token_app.command("list")
@async_to_sync
async def token_list(vault: VaultName) -> None:
    """List a vault's tokens. The tokens themselves can't be shown: only hashes are kept."""
    async with _storage(Settings()) as storage:
        found = await storage.list_tokens(await _find(storage, vault))
    if not found:
        typer.echo(f"The vault {vault} has no tokens.")
    width = max(
        (len(t.label) for t in found),
        default=0,
    )
    for t in found:
        used = iso(t.last_used) if t.last_used is not None else "never"
        typer.echo(
            f"{t.label:<{width}}  {t.scope:<5}  created: {iso(t.created)}  last used: {used}"
        )


@token_app.command("revoke")
@async_to_sync
async def token_revoke(vault: VaultName, label: Label) -> None:
    """Revoke a token: the device using it can no longer sync."""
    async with _storage(Settings()) as storage:
        if not await storage.revoke_token(await _find(storage, vault), label.strip()):
            _fail(f"The vault {vault} has no token called {label}.")
    typer.echo(f"Token {label} revoked.")
