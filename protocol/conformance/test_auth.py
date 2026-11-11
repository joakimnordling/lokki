"""Section 5.2: tokens and their scopes."""

import httpx2
import pytest

from conformance.conftest import Tokens, bearer
from conformance.helpers import key, keyring


@pytest.mark.parametrize(
    "headers",
    [{}, {"Authorization": "Bearer lk_unknown"}, {"Authorization": "Basic dXNlcjpwYXNz"}],
)
def test_requests_without_a_valid_token(http: httpx2.Client, headers: dict[str, str]) -> None:
    response = http.get("/v1/vault", headers=headers)

    assert response.status_code == 401
    assert response.json()["error"] == "unauthorized"


def test_a_read_token_can_read_but_not_write(http: httpx2.Client, vault: Tokens) -> None:
    read = bearer(vault["read"])

    assert http.get("/v1/vault", headers=read).status_code == 200
    assert http.get("/v1/vault/rows", headers=read).status_code == 200
    writes = [
        http.post(
            "/v1/vault/rows",
            headers=read,
            json={"base": 0, "mark": None, "rows": [{"key": key(1), "data": "v1.x"}]},
        ),
        http.put("/v1/vault/keyring", headers=read, json={"base": 0, "keyring": keyring()}),
        http.delete("/v1/vault", headers=read),
    ]
    assert [w.status_code for w in writes] == [403, 403, 403]
    assert {w.json()["error"] for w in writes} == {"forbidden"}


def test_vaults_are_separate(http: httpx2.Client, vault: Tokens, writer: dict[str, str]) -> None:
    http.post(
        "/v1/vault/rows",
        headers=writer,
        json={"base": 0, "mark": None, "rows": [{"key": key(1), "data": "v1.x"}]},
    )

    other = http.get("/v1/vault/rows", headers=bearer(vault["read"])).json()

    assert (other["rows"], other["head"]) == ([], 0)
