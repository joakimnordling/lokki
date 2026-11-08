from fastapi.testclient import TestClient
from syrupy.assertion import SnapshotAssertion
from syrupy.matchers import path_type

from lokki_server import __version__


def test_info_needs_no_token(client: TestClient, snapshot_json: SnapshotAssertion) -> None:
    response = client.get("/v1/info")

    assert response.status_code == 200
    assert response.json() == snapshot_json(matcher=path_type({"id": (str,), "version": (str,)}))
    assert response.json()["version"] == __version__


def test_server_id_stays_the_same(client: TestClient) -> None:
    first = client.get("/v1/info").json()["id"]

    assert client.get("/v1/info").json()["id"] == first
