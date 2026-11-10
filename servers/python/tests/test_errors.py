import pytest
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
        "/v1/vault/rows",
        headers={**writer, "Content-Type": "application/json"},
        content=b"{",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


def test_test_vaults_exist_only_in_test_mode(settings: Settings) -> None:
    with TestClient(create_app(settings.model_copy(update={"test_mode": False}))) as client:
        assert (
            client.post(
                "/v1/test/vaults",
                json={},
            ).status_code
            == 404
        )


def test_test_vaults_get_a_name(client: TestClient) -> None:
    made = client.post(
        "/v1/test/vaults",
        json={},
    )
    named = client.post(
        "/v1/test/vaults",
        json={"name": "jocke"},
    )
    again = client.post(
        "/v1/test/vaults",
        json={"name": "jocke"},
    )
    invalid = client.post(
        "/v1/test/vaults",
        json={"name": "two words"},
    )

    assert made.status_code == 201
    assert made.json()["name"].startswith("test-")
    assert named.json()["name"] == "jocke"
    assert again.status_code == 409
    assert again.json()["error"] == "name_taken"
    assert invalid.status_code == 400


def test_a_fault_in_the_server_is_an_error_like_any_other(settings: Settings) -> None:
    app = create_app(settings)

    @app.get("/v1/broken")
    async def broken() -> None:  # pyright: ignore[reportUnusedFunction]
        raise RuntimeError("a secret detail")

    with TestClient(
        app,
        raise_server_exceptions=False,
    ) as client:
        response = client.get("/v1/broken")

    assert response.status_code == 500
    assert response.json() == {
        "error": "internal",
        "message": "Something went wrong on the server. Try again later.",
    }
    assert "secret" not in response.text


def test_the_server_still_raises_the_fault_for_its_log(settings: Settings) -> None:
    app = create_app(settings)

    @app.get("/v1/broken")
    async def broken() -> None:  # pyright: ignore[reportUnusedFunction]
        raise RuntimeError("logged")

    with (
        TestClient(app) as client,
        pytest.raises(
            RuntimeError,
            match="logged",
        ),
    ):
        client.get("/v1/broken")


def test_errors_have_only_their_own_fields(client: TestClient, writer: dict[str, str]) -> None:
    client.post(
        "/v1/vault/rows",
        headers=writer,
        json={"base": 0, "mark": None, "rows": [{"key": "A" * 22, "data": "v1.x"}]},
    )

    stale = client.post(
        "/v1/vault/rows",
        headers=writer,
        json={"base": 0, "mark": None, "rows": [{"key": "B" * 22, "data": "v1.y"}]},
    )
    unknown = client.get(
        "/v1/vault",
        headers={"Authorization": "Bearer lk_nope"},
    )

    assert stale.json() == {
        "error": "behind",
        "message": "Pull first: the vault has changed.",
        "head": 1,
    }
    assert unknown.json() == {
        "error": "unauthorized",
        "message": "This token isn't valid on this server.",
    }
