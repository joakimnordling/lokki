from fastapi.testclient import TestClient
from syrupy.assertion import SnapshotAssertion
from syrupy.matchers import path_type

from tests.conftest import Tokens, bearer
from tests.helpers import key


def test_a_new_vault_is_empty(
    client: TestClient, reader: dict[str, str], snapshot_json: SnapshotAssertion
) -> None:
    response = client.get("/v1/vault", headers=reader)

    assert response.status_code == 200
    assert response.json() == snapshot_json(matcher=path_type({"changed": (str,)}))


def test_status_counts_rows_and_head(client: TestClient, writer: dict[str, str]) -> None:
    rows = [{"key": key(n), "data": f"v1.{n}"} for n in range(3)]
    first = client.post(
        "/v1/vault/rows", headers=writer, json={"base": 0, "mark": None, "rows": rows}
    )
    client.post(
        "/v1/vault/rows",
        headers=writer,
        json={"base": 3, "mark": first.json()["mark"], "rows": rows[:1]},
    )

    vault = client.get("/v1/vault", headers=writer).json()

    assert (vault["rows"], vault["head"], vault["mark"]) == (3, 4, "mark2")


def test_deleting_the_vault_removes_it_and_its_tokens(client: TestClient, vault: Tokens) -> None:
    write, read = bearer(vault["write"]), bearer(vault["read"])
    client.post(
        "/v1/vault/rows",
        headers=write,
        json={"base": 0, "mark": None, "rows": [{"key": key(1), "data": "v1.x"}]},
    )

    response = client.delete("/v1/vault", headers=write)

    assert response.status_code == 204
    assert response.content == b""
    for headers in (write, read):
        assert client.get("/v1/vault", headers=headers).status_code == 401
