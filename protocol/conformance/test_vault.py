"""Section 5.3: GET and DELETE /v1/vault, and PUT /v1/vault/keyring."""

import re
from typing import Any

import httpx2

from conformance.conftest import Tokens, bearer
from conformance.helpers import key, keyring


def put(
    http: httpx2.Client, headers: dict[str, str], base: int, ring: dict[str, Any]
) -> httpx2.Response:
    return http.put("/v1/vault/keyring", headers=headers, json={"base": base, "keyring": ring})


def test_a_new_vault(http: httpx2.Client, writer: dict[str, str]) -> None:
    vault = http.get("/v1/vault", headers=writer).json()

    assert {k: vault[k] for k in ("keyring", "keyring_version", "head", "rows")} == {
        "keyring": None,
        "keyring_version": 0,
        "head": 0,
        "rows": 0,
    }
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", vault["changed"])


def test_the_keyring_is_stored_as_sent(http: httpx2.Client, writer: dict[str, str]) -> None:
    entry = {**keyring()["keys"][0], "future": {"nested": [1, "two"]}}  # entries are free-form
    ring = keyring(keys=[entry])

    assert put(http, writer, 0, ring).json() == {"keyring_version": 1}
    vault = http.get("/v1/vault", headers=writer).json()
    assert (vault["keyring"], vault["keyring_version"]) == (ring, 1)


def test_a_keyring_with_other_fields_is_refused(
    http: httpx2.Client, writer: dict[str, str]
) -> None:
    response = put(http, writer, 0, keyring(unknown_field=True))

    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


def test_keyring_writes_need_the_current_version(
    http: httpx2.Client, writer: dict[str, str]
) -> None:
    put(http, writer, 0, keyring(u=1))
    put(http, writer, 1, keyring(u=2))

    stale = put(http, writer, 1, keyring(u=3))

    assert stale.status_code == 409
    assert stale.json()["error"] == "behind"
    assert stale.json()["keyring_version"] == 2
    assert http.get("/v1/vault", headers=writer).json()["keyring"]["u"] == 2


def test_a_keyring_of_another_vault_is_refused(http: httpx2.Client, writer: dict[str, str]) -> None:
    put(http, writer, 0, keyring(vault="first"))

    for base in (0, 1):
        other = put(http, writer, base, keyring(vault="second"))
        assert other.status_code == 409
        assert other.json()["error"] == "different_vault"


def test_status_counts_rows(http: httpx2.Client, writer: dict[str, str]) -> None:
    rows = [{"key": key(n), "data": "v1.x"} for n in range(3)]
    http.post("/v1/vault/rows", headers=writer, json={"base": 0, "rows": rows})
    http.post("/v1/vault/rows", headers=writer, json={"base": 3, "rows": rows[:1]})

    vault = http.get("/v1/vault", headers=writer).json()

    assert (vault["head"], vault["rows"]) == (4, 3)


def test_deleting_the_vault(http: httpx2.Client, vault: Tokens) -> None:
    write, read = bearer(vault["write"]), bearer(vault["read"])
    put(http, write, 0, keyring())

    assert http.delete("/v1/vault", headers=write).status_code == 204
    assert http.get("/v1/vault", headers=write).status_code == 401
    assert http.get("/v1/vault", headers=read).status_code == 401
