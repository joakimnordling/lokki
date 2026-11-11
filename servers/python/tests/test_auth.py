from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient

from tests.conftest import Tokens, bearer


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "lk_no-scheme"},
        {"Authorization": "Basic dXNlcjpwYXNz"},
        {"Authorization": "Bearer "},
        {"Authorization": "Bearer lk_not-a-real-token"},
    ],
)
def test_without_a_valid_token(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/v1/vault", headers=headers)

    assert response.status_code == 401
    assert response.json()["error"] == "unauthorized"
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_scheme_is_case_insensitive(client: TestClient, vault: Tokens) -> None:
    response = client.get("/v1/vault", headers={"Authorization": f"bearer {vault['read']}"})

    assert response.status_code == 200


def test_a_token_only_reaches_its_own_vault(
    client: TestClient, new_vault: Callable[[], Tokens]
) -> None:
    alice, bob = new_vault(), new_vault()
    row = {"key": "AAAAAAAAAAAAAAAAAAAAAA", "data": "v1.alice"}
    assert (
        client.post(
            "/v1/vault/rows",
            headers=bearer(alice["write"]),
            json={"base": 0, "mark": None, "rows": [row]},
        ).status_code
        == 200
    )

    pulled = client.get("/v1/vault/rows", headers=bearer(bob["read"])).json()

    assert pulled["rows"] == []
    assert pulled["head"] == 0


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        (
            "POST",
            "/v1/vault/rows",
            {"base": 0, "mark": None, "rows": [{"key": "AAAAAAAAAAAAAAAAAAAAAA", "data": "v1.x"}]},
        ),
        ("PUT", "/v1/vault/keyring", {"base": 0, "keyring": {}}),
        ("DELETE", "/v1/vault", None),
    ],
)
def test_a_read_token_cannot_write(
    client: TestClient, reader: dict[str, str], method: str, path: str, body: object
) -> None:
    response = client.request(method, path, headers=reader, json=body)

    assert response.status_code == 403
    assert response.json()["error"] == "forbidden"


def test_a_read_token_can_read(client: TestClient, reader: dict[str, str]) -> None:
    assert client.get("/v1/vault", headers=reader).status_code == 200
    assert client.get("/v1/vault/rows", headers=reader).status_code == 200
