"""The API docs: Swagger UI, ReDoc and the OpenAPI schema they're made from."""

import re

from fastapi.testclient import TestClient
from syrupy.assertion import SnapshotAssertion

from lokki_server.app import create_app
from lokki_server.config import Settings


def test_openapi_schema(client: TestClient, snapshot_json: SnapshotAssertion) -> None:
    """The documented API. A change here changes what clients may rely on: review it."""
    schema = client.get("/openapi.json").json()
    schema["info"]["version"] = "…"

    assert schema == snapshot_json


def test_every_operation_is_described(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    for path, methods in schema["paths"].items():
        for method, operation in methods.items():
            assert operation.get("summary"), f"{method} {path}"
            assert operation.get("description"), f"{method} {path}"
            assert operation.get("tags"), f"{method} {path}"
            assert "422" not in operation["responses"], f"{method} {path}"


def test_every_field_is_described(client: TestClient) -> None:
    schemas = client.get("/openapi.json").json()["components"]["schemas"]
    for name, model in schemas.items():
        if "properties" not in model:
            continue  # e.g. JsonValue, any JSON
        assert model.get("description"), name
        for field, spec in model.get("properties", {}).items():
            described = spec.get("description") or "$ref" in spec or "items" in spec
            assert described, f"{name}.{field}"


def test_endpoints_with_a_token_say_so(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()

    assert schema["components"]["securitySchemes"]["Token"]["scheme"] == "bearer"
    assert "security" not in schema["paths"]["/v1/info"]["get"]
    assert schema["paths"]["/v1/vault/rows"]["post"]["security"] == [{"Token": []}]


def test_docs_pages_load_nothing_from_other_sites(client: TestClient) -> None:
    for page in ("/docs", "/redoc"):
        response = client.get(page)
        assert response.status_code == 200
        assert "/openapi.json" in response.text
        assert not re.search(r"""(src|href)=["']?(https?:)?//""", response.text), page
        for asset in re.findall(r"""(?:src|href)=["']?(/[^"' >]+)""", response.text):
            assert client.get(asset).status_code == 200, asset


def test_test_mode_is_documented_only_in_test_mode(settings: Settings) -> None:
    with TestClient(create_app(settings.model_copy(update={"test_mode": False}))) as client:
        paths = client.get("/openapi.json").json()["paths"]

    assert "/v1/test/vaults" not in paths
    assert "/v1/vault/rows" in paths


def test_docs_can_be_turned_off(settings: Settings) -> None:
    with TestClient(create_app(settings.model_copy(update={"docs": False}))) as client:
        for page in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(page).status_code == 404
        assert client.get("/v1/info").status_code == 200
