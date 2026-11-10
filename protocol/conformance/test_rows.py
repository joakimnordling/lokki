"""Section 5.3: GET and POST /v1/vault/rows; 7.3: up to date to push; 7.4: marks of pushes."""

import re
from typing import Any

import httpx2
import pytest

from conformance.helpers import key

MARK = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def push(
    http: httpx2.Client,
    headers: dict[str, str],
    base: int,
    *rows: tuple[int, str],
    mark: str | None = None,
) -> httpx2.Response:
    body = {"base": base, "mark": mark, "rows": [{"key": key(n), "data": data} for n, data in rows]}
    return http.post("/v1/vault/rows", headers=headers, json=body)


def pull(http: httpx2.Client, headers: dict[str, str], **params: int | str) -> dict[str, Any]:
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
    pushed = push(http, writer, 0, (1, "v1.one"), (2, "v1.two")).json()
    assert set(pushed) == {"head", "mark"}
    assert pushed["head"] == 2
    assert MARK.match(pushed["mark"])

    page = pull(http, writer)

    assert page == {
        "rows": [
            {"key": key(1), "seq": 1, "data": "v1.one"},
            {"key": key(2), "seq": 2, "data": "v1.two"},
        ],
        "cursor": 2,
        "more": False,
        "head": 2,
        "mark": pushed["mark"],
    }


def test_data_is_stored_exactly(http: httpx2.Client, writer: dict[str, str]) -> None:
    data = "v1." + "".join(chr(c) for c in range(45, 123) if chr(c).isalnum() or chr(c) in "-_")
    push(http, writer, 0, (1, data), (2, "v9.from-a-newer-app"))

    assert [r["data"] for r in pull(http, writer)["rows"]] == [data, "v9.from-a-newer-app"]


def test_a_new_version_replaces_the_row(http: httpx2.Client, writer: dict[str, str]) -> None:
    mark = push(http, writer, 0, (1, "v1.a"), (2, "v1.b")).json()["mark"]
    push(http, writer, 2, (1, "v1.a2"), mark=mark)

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


def test_a_push_from_another_history_writes_nothing(
    http: httpx2.Client, writer: dict[str, str]
) -> None:
    """The right `base`, but not the push the device pulled up to: e.g. a restored server."""
    mark = push(http, writer, 0, (1, "v1.a")).json()["mark"]

    for other in (None, "x" + mark[1:] if mark[0] != "x" else "y" + mark[1:]):
        stale = push(http, writer, 1, (2, "v1.b"), mark=other)
        assert stale.status_code == 409
        assert stale.json()["error"] == "behind"
    assert push(http, writer, 1, (2, "v1.b"), mark=mark).status_code == 200


def test_marks_go_with_the_cursor(http: httpx2.Client, writer: dict[str, str]) -> None:
    first = push(http, writer, 0, (1, "v1.a"), (2, "v1.b")).json()["mark"]
    second = push(http, writer, 2, (3, "v1.c"), mark=first).json()["mark"]
    assert first != second

    page = pull(http, writer, limit=1)
    assert (page["cursor"], page["mark"]) == (1, first)
    page = pull(http, writer, since=1, mark=first, limit=1)
    assert (page["cursor"], page["mark"]) == (2, first)
    page = pull(http, writer, since=2, mark=first)
    assert (page["cursor"], page["mark"]) == (3, second)
    assert pull(http, writer, since=3, mark=second)["rows"] == []


def test_a_pull_from_another_history_is_refused(
    http: httpx2.Client, writer: dict[str, str]
) -> None:
    """Section 7.4: row `since` wasn't written by the push with this mark, or never at all."""
    first = push(http, writer, 0, (1, "v1.a"), (2, "v1.b")).json()["mark"]
    second = push(http, writer, 2, (3, "v1.c"), mark=first).json()["mark"]

    for since, mark in ((2, second), (3, first), (50, second)):
        response = http.get("/v1/vault/rows", headers=writer, params={"since": since, "mark": mark})
        assert response.status_code == 409
        assert response.json()["error"] == "history_changed"
        assert isinstance(response.json()["message"], str)


def test_paging(http: httpx2.Client, writer: dict[str, str]) -> None:
    push(http, writer, 0, *((n, f"v1.{n}") for n in range(1, 8)))

    rows, cursor = pull_all(http, writer, limit=2)

    assert [r["seq"] for r in rows] == list(range(1, 8))
    assert cursor == 7


def test_paging_over_replaced_rows(http: httpx2.Client, writer: dict[str, str]) -> None:
    mark = push(http, writer, 0, *((n, "v1.old") for n in range(1, 6))).json()["mark"]
    mark = push(http, writer, 5, (2, "v1.new"), (4, "v1.new"), mark=mark).json()["mark"]

    rows, cursor = pull_all(http, writer, since=0, limit=2)

    assert sorted(r["key"] for r in rows) == sorted(key(n) for n in range(1, 6))
    assert cursor == 7
    assert pull(http, writer, since=7) == {
        "rows": [],
        "cursor": 7,
        "more": False,
        "head": 7,
        "mark": mark,
    }


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
        {"base": 0, "mark": None, "rows": []},
        {"base": -1, "mark": None, "rows": [{"key": key(1), "data": "v1.x"}]},
        {"base": 0, "mark": None, "rows": [{"key": "too-short", "data": "v1.x"}]},
        {"base": 0, "mark": None, "rows": [{"key": key(1), "data": ""}]},
        {
            "base": 0,
            "mark": None,
            "rows": [{"key": key(1), "data": "v1.a"}, {"key": key(1), "data": "v1.b"}],
        },
        {"rows": [{"key": key(1), "data": "v1.x"}]},
        {"base": 0, "rows": [{"key": key(1), "data": "v1.x"}]},
        {"base": 0, "mark": "has spaces", "rows": [{"key": key(1), "data": "v1.x"}]},
    ],
)
def test_invalid_pushes(http: httpx2.Client, writer: dict[str, str], body: dict[str, Any]) -> None:
    response = http.post("/v1/vault/rows", headers=writer, json=body)

    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"
    assert isinstance(response.json()["message"], str)
