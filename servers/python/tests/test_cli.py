import re

import pytest
from typer.testing import CliRunner

from lokki_server.auth import hash_token
from lokki_server.cli import app

runner = CliRunner(env={"COLUMNS": "300"})  # no wrapping in error messages


@pytest.fixture(autouse=True)
def environment(database_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOKKI_DATABASE_URL", database_url)
    monkeypatch.setenv("LOKKI_PUBLIC_URL", "https://sync.example.com")


def run(*args: str) -> str:
    result = runner.invoke(app, list(args))
    assert result.exit_code == 0, result.output
    return result.output


def test_vault_and_tokens() -> None:
    assert "Vault jocke created" in run("vault", "add", "jocke")

    added = run("token", "add", "jocke", "iPhone 17 Pro")
    assert "Token iPhone 17 Pro (write) for the vault jocke" in added
    assert "URL:    https://sync.example.com" in added
    token = re.search(r"Token:\s+(lk_\S+)", added)
    assert token is not None
    assert len(hash_token(token.group(1))) == 64
    assert "(read)" in run("token", "add", "jocke", "browser", "--scope", "read")

    assert re.search(r"^jocke  rows: 0  head: 0  tokens: 2  created: ", run("vault", "list"))

    tokens = run("token", "list", "jocke").splitlines()
    assert re.match(r"iPhone 17 Pro  write  created: .*  last used: never", tokens[0])
    assert re.match(r"browser        read   created: ", tokens[1])

    assert "Token browser revoked." in run("token", "revoke", "jocke", "browser")
    assert "tokens: 1" in run("vault", "list")
    assert "Vault jocke deleted." in run("vault", "delete", "jocke", "--yes")
    assert "No vaults yet" in run("vault", "list")


def fails(*args: str) -> str:
    result = runner.invoke(app, list(args))
    assert result.exit_code != 0, result.output
    return result.output


@pytest.mark.parametrize("name", ["jocke", "Jocke", "j", "jocke_2", "jocke-test", "a.b+c@d", "1"])
def test_vault_names_that_are_allowed(name: str) -> None:
    assert f"Vault {name} created" in run("vault", "add", name)


@pytest.mark.parametrize("name", ["-jocke", "_x", "jöcke", "two words", "a/b", "x" * 65])
def test_vault_names_that_are_refused(name: str) -> None:
    assert "can't be a vault's name" in fails("vault", "add", "--", name)


def test_vault_names_are_case_sensitive_and_unique() -> None:
    run("vault", "add", "jocke")
    run("vault", "add", "Jocke")

    assert "There's a vault called jocke already." in fails("vault", "add", "jocke")
    assert "tokens: 0" in run("vault", "list")
    assert len(run("vault", "list").splitlines()) == 2


def test_token_labels_are_unique_within_a_vault() -> None:
    run("vault", "add", "jocke")
    run("vault", "add", "alex")
    run("token", "add", "jocke", "browser")

    assert "has a token called browser already" in fails("token", "add", "jocke", "browser")
    run("token", "add", "alex", "browser")  # another vault: fine


def test_token_labels_are_trimmed_and_checked() -> None:
    run("vault", "add", "jocke")
    run("token", "add", "jocke", "  laptop  ")

    assert run("token", "list", "jocke").startswith("laptop  write")
    assert "1 to 100 characters" in fails("token", "add", "jocke", "   ")
    assert "1 to 100 characters" in fails("token", "add", "jocke", "x" * 101)
    assert "Token laptop revoked." in run("token", "revoke", "jocke", "laptop")


def test_missing_things_are_reported() -> None:
    run("vault", "add", "jocke")
    for args in (
        ["token", "add", "alex", "phone"],
        ["token", "list", "alex"],
        ["vault", "delete", "alex", "--yes"],
    ):
        assert "There's no vault called alex." in fails(*args)
    assert "has no token called phone" in fails("token", "revoke", "jocke", "phone")


def test_delete_asks_first() -> None:
    run("vault", "add", "jocke")

    result = runner.invoke(app, ["vault", "delete", "jocke"], input="n\n")

    assert result.exit_code == 1
    assert "jocke" in run("vault", "list")


def test_tokens_of_a_vault_without_any() -> None:
    run("vault", "add", "jocke")

    assert "The vault jocke has no tokens." in run("token", "list", "jocke")


def test_migrate() -> None:
    assert "up to date" in run("migrate")


def test_serve_migrates_then_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, int]] = []

    def fake_run(_app: object, *, host: str, port: int, **_: object) -> None:
        calls.append((host, port))

    monkeypatch.setattr("lokki_server.cli.uvicorn.run", fake_run)

    run("serve", "--port", "9000", "--host", "0.0.0.0")

    assert calls == [("0.0.0.0", 9000)]
    assert "No vaults yet" in run("vault", "list")  # the tables exist
