import re

import pytest
from typer.testing import CliRunner

from lokki_server.auth import hash_token
from lokki_server.cli import app

runner = CliRunner()


@pytest.fixture(autouse=True)
def environment(database_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOKKI_DATABASE_URL", database_url)
    monkeypatch.setenv("LOKKI_PUBLIC_URL", "https://sync.example.com")


def run(*args: str) -> str:
    result = runner.invoke(app, list(args))
    assert result.exit_code == 0, result.output
    return result.output


def test_account_lifecycle() -> None:
    created = run("add-account", "Home")
    token = re.search(r"Token:\s+(\S+)", created)
    assert token is not None
    assert "URL:     https://sync.example.com" in created
    assert token.group(1).startswith("lk_")
    assert len(hash_token(token.group(1))) == 64

    added = run("add-token", "1", "--scope", "read")
    assert re.search(r"Token 2 \(read\): lk_\S+", added)

    listed = run("accounts")
    assert re.search(r"1  Home  rows: 0  head: 0  tokens: 2", listed)

    tokens = run("tokens", "1")
    assert re.search(r"1  write .* last used: never", tokens)
    assert re.search(r"2  read ", tokens)

    assert "Token 2 revoked." in run("revoke", "2")
    assert "Account 1 deleted." in run("delete-account", "1", "--yes")
    assert "No accounts yet" in run("accounts")


def test_missing_things_are_reported() -> None:
    for args in (["add-token", "9"], ["revoke", "9"], ["delete-account", "9", "--yes"]):
        result = runner.invoke(app, args)
        assert result.exit_code == 1
        assert "There's no" in result.output


def test_delete_asks_first() -> None:
    run("add-account", "Home")

    result = runner.invoke(app, ["delete-account", "1"], input="n\n")

    assert result.exit_code == 1
    assert "tokens: 1" in run("accounts")


def test_tokens_of_an_account_without_any() -> None:
    assert "has no tokens" in run("tokens", "5")


def test_migrate() -> None:
    assert "up to date" in run("migrate")


def test_serve_migrates_then_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, int]] = []

    def fake_run(_app: object, *, host: str, port: int, **_: object) -> None:
        calls.append((host, port))

    monkeypatch.setattr("lokki_server.cli.uvicorn.run", fake_run)

    run("serve", "--port", "9000", "--host", "0.0.0.0")

    assert calls == [("0.0.0.0", 9000)]
    assert "No accounts yet" in run("accounts")  # the tables exist
