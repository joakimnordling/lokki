from fastapi.testclient import TestClient

from lokki_server.app import create_app
from lokki_server.config import Settings


def test_unknown_path(client: TestClient) -> None:
    response = client.get("/v1/nothing-here")

    assert response.status_code == 404
    assert response.json() == {"error": "not_found", "message": "Not Found"}


def test_wrong_method(client: TestClient) -> None:
    response = client.patch("/v1/vault")

    assert response.status_code == 405
    assert response.json()["error"] == "method_not_allowed"


def test_invalid_json(client: TestClient, writer: dict[str, str]) -> None:
    response = client.post(
        "/v1/vault/rows", headers={**writer, "Content-Type": "application/json"}, content=b"{"
    )

    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


def test_test_vaults_exist_only_in_test_mode(settings: Settings) -> None:
    with TestClient(create_app(settings.model_copy(update={"test_mode": False}))) as client:
        assert client.post("/v1/test/vaults", json={}).status_code == 404


def test_test_vaults_get_a_name(client: TestClient) -> None:
    made = client.post("/v1/test/vaults", json={})
    named = client.post("/v1/test/vaults", json={"name": "jocke"})
    again = client.post("/v1/test/vaults", json={"name": "jocke"})
    invalid = client.post("/v1/test/vaults", json={"name": "two words"})

    assert made.status_code == 201
    assert made.json()["name"].startswith("test-")
    assert named.json()["name"] == "jocke"
    assert again.status_code == 409
    assert again.json()["error"] == "name_taken"
    assert invalid.status_code == 400
