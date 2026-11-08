"""The ``lokki-server`` command: run the server and manage accounts and tokens."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Annotated

import typer
import uvicorn

from lokki_server._sync import async_to_sync
from lokki_server.app import create_app
from lokki_server.auth import hash_token, new_token
from lokki_server.clock import iso, now_ms
from lokki_server.config import Settings
from lokki_server.models import Scope
from lokki_server.storage import Storage, migrate, open_storage

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
    port: Annotated[int, typer.Option(envvar="PORT", help="Port (also from $PORT)")] = 8000,
    migrate_first: Annotated[
        bool, typer.Option("--migrate/--no-migrate", help="Update the database's tables first")
    ] = True,
) -> None:
    """Run the server."""
    settings = Settings()
    if migrate_first:
        migrate(settings.database_url)
    uvicorn.run(create_app(settings), host=host, port=port, proxy_headers=True)


@app.command("migrate")
def migrate_command() -> None:
    """Update the database's tables to this version of the server."""
    migrate(Settings().database_url)
    typer.echo("The database is up to date.")


@app.command()
@async_to_sync
async def add_account(
    name: Annotated[str, typer.Argument(help="A name for the account, e.g. who it's for")],
    scope: ScopeOption = "write",
) -> None:
    """Create an account (one vault) and print the URL and a token to enter in the app."""
    settings = Settings()
    async with _storage(settings) as storage:
        now = now_ms()
        account_id = await storage.create_account(name, now)
        token = new_token()
        await storage.add_token(account_id, hash_token(token), scope, now)
    typer.echo(f"Account: {account_id} ({name})")
    typer.echo(f"URL:     {settings.public_url}")
    typer.echo(f"Token:   {token}    (shown only now)")


@app.command()
@async_to_sync
async def add_token(
    account: Annotated[int, typer.Argument(help="The account's number")],
    scope: ScopeOption = "write",
) -> None:
    """Add a token to an account, e.g. one per device, or a read-only one."""
    settings = Settings()
    async with _storage(settings) as storage:
        if account not in {a.account_id for a in await storage.list_accounts()}:
            typer.echo(f"There's no account {account}.", err=True)
            raise typer.Exit(1)
        token = new_token()
        token_id = await storage.add_token(account, hash_token(token), scope, now_ms())
    typer.echo(f"Token {token_id} ({scope}): {token}    (shown only now)")


@app.command()
@async_to_sync
async def accounts() -> None:
    """List the accounts."""
    async with _storage(Settings()) as storage:
        found = await storage.list_accounts()
    if not found:
        typer.echo("No accounts yet. Create one with: lokki-server add-account NAME")
    for a in found:
        typer.echo(
            f"{a.account_id:>4}  {a.name}  rows: {a.rows}  head: {a.head}  tokens: {a.tokens}"
            f"  created: {iso(a.created)}"
        )


@app.command()
@async_to_sync
async def tokens(account: Annotated[int, typer.Argument(help="The account's number")]) -> None:
    """List an account's tokens. The tokens themselves can't be shown: only hashes are kept."""
    async with _storage(Settings()) as storage:
        found = await storage.list_tokens(account)
    if not found:
        typer.echo(f"Account {account} has no tokens.")
    for t in found:
        used = iso(t.last_used) if t.last_used is not None else "never"
        typer.echo(f"{t.token_id:>4}  {t.scope:<5}  created: {iso(t.created)}  last used: {used}")


@app.command()
@async_to_sync
async def revoke(token: Annotated[int, typer.Argument(help="The token's number")]) -> None:
    """Revoke a token: devices using it can no longer sync."""
    async with _storage(Settings()) as storage:
        done = await storage.revoke_token(token)
    if not done:
        typer.echo(f"There's no token {token}.", err=True)
        raise typer.Exit(1)
    typer.echo(f"Token {token} revoked.")


@app.command()
@async_to_sync
async def delete_account(
    account: Annotated[int, typer.Argument(help="The account's number")],
    yes: Annotated[bool, typer.Option("--yes", help="Don't ask for confirmation")] = False,
) -> None:
    """Delete an account with its vault and tokens. This can't be undone."""
    if not yes:
        typer.confirm(f"Delete account {account}, its vault and all its tokens?", abort=True)
    async with _storage(Settings()) as storage:
        done = await storage.delete_account(account)
    if not done:
        typer.echo(f"There's no account {account}.", err=True)
        raise typer.Exit(1)
    typer.echo(f"Account {account} deleted.")
