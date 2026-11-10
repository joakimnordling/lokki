from fastapi.testclient import TestClient

from tests.conftest import ORIGIN


def test_preflight_from_the_app(client: TestClient) -> None:
    response = client.options(
        "/v1/vault/rows",
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization, content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert "POST" in response.headers["access-control-allow-methods"]
    assert "authorization" in response.headers["access-control-allow-headers"].lower()
    assert "access-control-allow-credentials" not in response.headers


def test_responses_to_the_app_allow_it(client: TestClient) -> None:
    response = client.get("/v1/info", headers={"Origin": ORIGIN})

    assert response.headers["access-control-allow-origin"] == ORIGIN


def test_other_origins_get_no_cors_headers(client: TestClient) -> None:
    response = client.get("/v1/info", headers={"Origin": "https://elsewhere.example.org"})

    assert "access-control-allow-origin" not in response.headers
