from typing import Any

import pytest
from fastapi.testclient import TestClient
from syrupy.assertion import SnapshotAssertion

from lokki_server.config import Limits
from tests.helpers import key


def push(client: TestClient, headers: dict[str, str], base: int, *rows: tuple[int, str]) -> Any:
    body = {"base": base, "rows": [{"key": key(n), "data": data} for n, data in rows]}
    return client.post("/v1/vault/rows", headers=headers, json=body)


def pull(client: TestClient, headers: dict[str, str], **params: int) -> Any:
    response = client.get("/v1/vault/rows", headers=headers, params=params)
    assert response.status_code == 200
    return response.json()


def test_push_then_pull(
    client: TestClient, writer: dict[str, str], snapshot_json: SnapshotAssertion
) -> None:
    pushed = push(client, writer, 0, (1, "v1.one"), (2, "v1.two"))

    assert pushed.json() == {"head": 2}
    assert pull(client, writer) == snapshot_json


def test_a_new_version_replaces_the_row_and_gets_a_new_number(
    client: TestClient, writer: dict[str, str]
) -> None:
    push(client, writer, 0, (1, "v1.one"), (2, "v1.two"))
    push(client, writer, 2, (1, "v1.one-again"))

    everything = pull(client, writer)

    assert [(r["key"], r["seq"], r["data"]) for r in everything["rows"]] == [
        (key(2), 2, "v1.two"),
        (key(1), 3, "v1.one-again"),
    ]
    assert pull(client, writer, since=2)["rows"] == [
        {"key": key(1), "seq": 3, "data": "v1.one-again"}
    ]


def test_a_push_that_isnt_up_to_date_writes_nothing(
    client: TestClient, writer: dict[str, str]
) -> None:
    push(client, writer, 0, (1, "v1.one"))

    stale = push(client, writer, 0, (2, "v1.two"))

    assert stale.status_code == 409
    assert stale.json() == {
        "error": "behind",
        "message": "Pull first: the vault has changed.",
        "head": 1,
    }
    assert [r["key"] for r in pull(client, writer)["rows"]] == [key(1)]


def test_paging(client: TestClient, writer: dict[str, str]) -> None:
    push(client, writer, 0, *((n, f"v1.{n}") for n in range(1, 6)))

    first = pull(client, writer, limit=2)
    second = pull(client, writer, since=first["cursor"], limit=2)
    third = pull(client, writer, since=second["cursor"], limit=2)

    assert [(len(p["rows"]), p["cursor"], p["more"]) for p in (first, second, third)] == [
        (2, 2, True),
        (2, 4, True),
        (1, 5, False),
    ]
    assert third["head"] == 5


def test_the_cursor_reaches_the_head_when_newer_versions_left_gaps(
    client: TestClient, writer: dict[str, str]
) -> None:
    push(client, writer, 0, (1, "v1.a"), (2, "v1.b"))
    push(client, writer, 2, (1, "v1.a2"), (2, "v1.b2"))

    result = pull(client, writer, since=1)

    assert [r["seq"] for r in result["rows"]] == [3, 4]
    assert (result["cursor"], result["more"], result["head"]) == (4, False, 4)
    assert pull(client, writer, since=4) == {"rows": [], "cursor": 4, "more": False, "head": 4}


def test_since_beyond_the_head(client: TestClient, writer: dict[str, str]) -> None:
    push(client, writer, 0, (1, "v1.a"))

    result = pull(client, writer, since=50)

    assert result == {"rows": [], "cursor": 1, "more": False, "head": 1}


@pytest.mark.parametrize("limits", [Limits(pull=3, push=5, row_bytes=256)])
def test_limit_is_an_upper_bound(client: TestClient, writer: dict[str, str]) -> None:
    push(client, writer, 0, *((n, "v1.x") for n in range(1, 6)))

    assert len(pull(client, writer)["rows"]) == 3
    assert len(pull(client, writer, limit=100)["rows"]) == 3
    assert len(pull(client, writer, limit=1)["rows"]) == 1


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"base": 0, "rows": []}, 400),
        ({"base": -1, "rows": [{"key": key(1), "data": "v1.x"}]}, 400),
        ({"base": 0, "rows": [{"key": "short", "data": "v1.x"}]}, 400),
        ({"base": 0, "rows": [{"key": key(1) + "=", "data": "v1.x"}]}, 400),
        ({"base": 0, "rows": [{"key": key(1), "data": ""}]}, 400),
        (
            {"base": 0, "rows": [{"key": key(1), "data": "v1.a"}, {"key": key(1), "data": "v1.b"}]},
            400,
        ),
        ({"base": 0, "rows": [{"key": key(n), "data": "v1.x"} for n in range(6)]}, 413),
        ({"base": 0, "rows": [{"key": key(1), "data": "v1." + "x" * 300}]}, 413),
    ],
)
def test_invalid_pushes(
    client: TestClient, writer: dict[str, str], body: dict[str, Any], status: int
) -> None:
    response = client.post("/v1/vault/rows", headers=writer, json=body)

    assert response.status_code == status
    assert response.json()["error"] == ("too_large" if status == 413 else "invalid_request")
    assert pull(client, writer)["head"] == 0


@pytest.mark.parametrize("params", [{"since": -1}, {"limit": 0}, {"since": "x"}])
def test_invalid_pulls(client: TestClient, writer: dict[str, str], params: dict[str, Any]) -> None:
    response = client.get("/v1/vault/rows", headers=writer, params=params)

    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"
