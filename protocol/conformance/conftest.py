"""
Fixtures for checking a sync server over HTTP, whatever it's written in.

Set ``LOKKI_SERVER_URL`` to a running server in test mode (section 5.5). Without it, the Python
server in ``servers/python`` is started in test mode on a free port with a temporary SQLite
database.
"""

import os
import socket
import subprocess
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx2
import pytest

PYTHON_SERVER = Path(__file__).parents[2] / "servers" / "python"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
        return port


@pytest.fixture(scope="session")
def server_url(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    url = os.environ.get("LOKKI_SERVER_URL")
    if url:
        yield url.rstrip("/")
        return
    port = _free_port()
    database = tmp_path_factory.mktemp("server") / "lokki.db"
    env = {
        **os.environ,
        "LOKKI_DATABASE_URL": f"sqlite+aiosqlite:///{database}",
        "LOKKI_TEST_MODE": "true",
    }
    process = subprocess.Popen(
        [
            "uv",
            "run",
            "--project",
            str(PYTHON_SERVER),
            "lokki-server",
            "serve",
            "--port",
            str(port),
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 60
        while True:
            try:
                httpx2.get(f"{url}/v1/info", timeout=1).raise_for_status()
                break
            except httpx2.HTTPError:
                if process.poll() is not None or time.monotonic() > deadline:
                    _, err = process.communicate(timeout=5)
                    pytest.fail(f"the server didn't start:\n{err.decode()}")
                time.sleep(0.2)
        yield url
    finally:
        process.terminate()
        process.communicate(timeout=10)  # also closes the stderr pipe


@pytest.fixture
def http(server_url: str) -> Iterator[httpx2.Client]:
    with httpx2.Client(base_url=server_url, timeout=30) as client:
        yield client


@pytest.fixture(scope="session")
def limits(server_url: str) -> dict[str, int]:
    found: dict[str, int] = httpx2.get(f"{server_url}/v1/info").json()["limits"]
    return found


Tokens = dict[str, str]


@pytest.fixture
def new_vault(http: httpx2.Client) -> Callable[[], Tokens]:
    """A fresh, empty vault with a write and a read token (test mode)."""

    def make() -> Tokens:
        response = http.post("/v1/test/vaults", json={})
        assert response.status_code == 201, "the server must run in test mode (section 5.5)"
        tokens: Tokens = response.json()
        assert set(tokens) >= {"write", "read"}
        return tokens

    return make


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def writer(new_vault: Callable[[], Tokens]) -> dict[str, str]:
    return bearer(new_vault()["write"])


@pytest.fixture
def vault(new_vault: Callable[[], Tokens]) -> Tokens:
    return new_vault()
