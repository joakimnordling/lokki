"""Section 5.3: GET and POST /v1/vault/rows, and section 7.3: up to date to push."""

from typing import Any

import httpx2
import pytest

from conformance.helpers import key


def push(
    http: httpx2.Client, headers: dict[str, str], base: int, *rows: tuple[int, str]
) -> httpx2.Response:
    body = {"base": base, "rows": [{"key": key(n), "data": data} for n, data in rows]}
    return http.post("/v1/vault/rows", headers=headers, json=body)


def pull(http: httpx2.Client, headers: dict[str, str], **params: int) -> dict[str, Any]:
    response = http.get("/v1/vault/rows", headers=headers, params=params)
    assert response.status_code == 200
    result: dict[str, Any] = response.json()
    return result


def pull_all(
    http: httpx2.Client, headers: dict[str, str], since: int = 0, limit: int = 1000
) -> tuple[list[dict[str, Any]], int]:
    """Every row after `since`, following `cursor` while `more` is true."""
    rows: list[dict[str, Any]] = []
    while True:
        page = pull(http, headers, since=since, limit=limit)
        assert page["rows"] or not page["more"], "at least one row while more is true"
        rows += page["rows"]
        since = page["cursor"]
        if not page["more"]:
            assert page["cursor"] == page["head"], "the cursor reaches the head on the last page"
            return rows, since


def test_push_and_pull(http: httpx2.Client, writer: dict[str, str]) -> None:
    assert push(http, writer, 0, (1, "v1.one"), (2, "v1.two")).json() == {"head": 2}

    page = pull(http, writer)

    assert page == {
        "rows": [
            {"key": key(1), "seq": 1, "data": "v1.one"},
            {"key": key(2), "seq": 2, "data": "v1.two"},
        ],
        "cursor": 2,
        "more": False,
        "head": 2,
    }


def test_data_is_stored_exactly(http: httpx2.Client, writer: dict[str, str]) -> None:
    data = "v1." + "".join(chr(c) for c in range(45, 123) if chr(c).isalnum() or chr(c) in "-_")
    push(http, writer, 0, (1, data), (2, "v9.from-a-newer-app"))

    assert [r["data"] for r in pull(http, writer)["rows"]] == [data, "v9.from-a-newer-app"]


def test_a_new_version_replaces_the_row(http: httpx2.Client, writer: dict[str, str]) -> None:
    push(http, writer, 0, (1, "v1.a"), (2, "v1.b"))
    push(http, writer, 2, (1, "v1.a2"))

    rows, _ = pull_all(http, writer)

    assert [(r["key"], r["seq"], r["data"]) for r in rows] == [
        (key(2), 2, "v1.b"),
        (key(1), 3, "v1.a2"),
    ]
    assert pull(http, writer, since=2)["rows"] == [{"key": key(1), "seq": 3, "data": "v1.a2"}]


def test_a_push_that_isnt_up_to_date_writes_nothing(
    http: httpx2.Client, writer: dict[str, str]
) -> None:
    push(http, writer, 0, (1, "v1.a"))

    for base in (0, 2):
        stale = push(http, writer, base, (2, "v1.b"))
        assert stale.status_code == 409
        assert stale.json()["error"] == "behind"
        assert stale.json()["head"] == 1
    assert pull(http, writer)["head"] == 1


def test_paging(http: httpx2.Client, writer: dict[str, str]) -> None:
    push(http, writer, 0, *((n, f"v1.{n}") for n in range(1, 8)))

    rows, cursor = pull_all(http, writer, limit=2)

    assert [r["seq"] for r in rows] == list(range(1, 8))
    assert cursor == 7


def test_paging_over_replaced_rows(http: httpx2.Client, writer: dict[str, str]) -> None:
    push(http, writer, 0, *((n, "v1.old") for n in range(1, 6)))
    push(http, writer, 5, (2, "v1.new"), (4, "v1.new"))

    rows, cursor = pull_all(http, writer, since=0, limit=2)

    assert sorted(r["key"] for r in rows) == sorted(key(n) for n in range(1, 6))
    assert cursor == 7
    assert pull(http, writer, since=7) == {"rows": [], "cursor": 7, "more": False, "head": 7}


def test_limit_is_an_upper_bound(
    http: httpx2.Client, writer: dict[str, str], limits: dict[str, int]
) -> None:
    push(http, writer, 0, *((n, "v1.x") for n in range(1, 4)))

    assert len(pull(http, writer, limit=1)["rows"]) <= 1
    page = pull(http, writer, limit=limits["pull"] + 10)
    assert len(page["rows"]) <= limits["pull"]


def test_since_beyond_the_head(http: httpx2.Client, writer: dict[str, str]) -> None:
    push(http, writer, 0, (1, "v1.x"))

    page = pull(http, writer, since=100)

    assert (page["rows"], page["more"], page["head"]) == ([], False, 1)


def test_limits_are_enforced(
    http: httpx2.Client, writer: dict[str, str], limits: dict[str, int]
) -> None:
    too_many = push(http, writer, 0, *((n, "v1.x") for n in range(limits["push"] + 1)))
    too_big = push(http, writer, 0, (1, "v1." + "x" * limits["row_bytes"]))

    assert (too_many.status_code, too_big.status_code) == (413, 413)
    assert pull(http, writer)["head"] == 0


@pytest.mark.parametrize(
    "body",
    [
        {"base": 0, "rows": []},
        {"base": -1, "rows": [{"key": key(1), "data": "v1.x"}]},
        {"base": 0, "rows": [{"key": "too-short", "data": "v1.x"}]},
        {"base": 0, "rows": [{"key": key(1), "data": ""}]},
        {"base": 0, "rows": [{"key": key(1), "data": "v1.a"}, {"key": key(1), "data": "v1.b"}]},
        {"rows": [{"key": key(1), "data": "v1.x"}]},
    ],
)
def test_invalid_pushes(http: httpx2.Client, writer: dict[str, str], body: dict[str, Any]) -> None:
    response = http.post("/v1/vault/rows", headers=writer, json=body)

    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"
    assert isinstance(response.json()["message"], str)
