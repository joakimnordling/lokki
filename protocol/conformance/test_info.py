"""Section 5.3: GET /v1/info."""

import uuid

import httpx2


def test_info_without_sign_in(http: httpx2.Client) -> None:
    response = http.get("/v1/info")

    assert response.status_code == 200
    info = response.json()
    assert info["server"] == "lokki"
    assert isinstance(info["version"], str)
    assert 1 in info["api"]
    assert {"pull", "push", "row_bytes"} <= set(info["limits"])
    assert all(isinstance(v, int) and v > 0 for v in info["limits"].values())


def test_the_server_id_is_stable(http: httpx2.Client) -> None:
    first = http.get("/v1/info").json()["id"]

    assert first == http.get("/v1/info").json()["id"]
    assert uuid.UUID(first)
