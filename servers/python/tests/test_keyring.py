from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.helpers import keyring


def put(client: TestClient, headers: dict[str, str], base: int, ring: dict[str, Any]) -> Any:
    return client.put("/v1/vault/keyring", headers=headers, json={"base": base, "keyring": ring})


def test_first_keyring_and_reading_it_back(client: TestClient, writer: dict[str, str]) -> None:
    ring = keyring()

    response = put(client, writer, 0, ring)

    assert response.status_code == 200
    assert response.json() == {"keyring_version": 1}
    vault = client.get("/v1/vault", headers=writer).json()
    assert vault["keyring"] == ring  # exactly as sent
    assert vault["keyring_version"] == 1


def test_replacing_needs_the_current_version(client: TestClient, writer: dict[str, str]) -> None:
    put(client, writer, 0, keyring(u=1))
    assert put(client, writer, 1, keyring(u=2)).json() == {"keyring_version": 2}

    stale = put(client, writer, 1, keyring(u=3))

    assert stale.status_code == 409
    assert stale.json()["error"] == "behind"
    assert stale.json()["keyring_version"] == 2
    assert client.get("/v1/vault", headers=writer).json()["keyring"]["u"] == 2


def test_a_keyring_of_another_vault_is_refused(client: TestClient, writer: dict[str, str]) -> None:
    put(client, writer, 0, keyring(vault="first"))

    other = put(client, writer, 1, keyring(vault="second"))

    assert other.status_code == 409
    assert other.json()["error"] == "different_vault"
    assert client.get("/v1/vault", headers=writer).json()["keyring"]["vault"] == "first"


def test_two_first_keyrings_of_different_vaults(client: TestClient, writer: dict[str, str]) -> None:
    put(client, writer, 0, keyring(vault="first"))

    late = put(client, writer, 0, keyring(vault="second"))

    assert late.status_code == 409
    assert late.json()["error"] == "different_vault"


@pytest.mark.parametrize(
    "ring",
    [
        {**keyring(), "format": "something-else"},
        {k: v for k, v in keyring().items() if k != "vault"},
        {**keyring(), "u": "soon"},
        {k: v for k, v in keyring().items() if k != "mac"},
        {**keyring(), "keys": []},
        keyring(future_field=True),
        {**keyring(), "version": "1"},  # never converted: that would break the mac
        {**keyring(), "u": 1794130000000.0},
        {**keyring(), "u": 2**53},
        keyring(keys=[{**keyring()["keys"][0], "created": 1.5}]),
        keyring(keys=[{**keyring()["keys"][0], "big": -(2**53)}]),
        keyring(keys=[{**keyring()["keys"][0], "näme": "x"}]),
        [],
    ],
)
def test_invalid_keyrings(client: TestClient, writer: dict[str, str], ring: Any) -> None:
    response = client.put("/v1/vault/keyring", headers=writer, json={"base": 0, "keyring": ring})

    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


def test_a_too_large_keyring(client: TestClient, writer: dict[str, str]) -> None:
    big = {**keyring()["keys"][0], "wrapped": "x" * 20000}
    response = put(client, writer, 0, keyring(keys=[big]))

    assert response.status_code == 413
    assert response.json()["error"] == "too_large"


def test_entries_may_hold_strings_integers_booleans_and_null(
    client: TestClient,
    writer: dict[str, str],
) -> None:
    entry = {**keyring()["keys"][0], "flags": [True, None, 2**53 - 1, -(2**53 - 1)], "note": "näme"}
    ring = keyring(keys=[entry])

    assert put(client, writer, 0, ring).status_code == 200
    assert client.get("/v1/vault", headers=writer).json()["keyring"] == ring
