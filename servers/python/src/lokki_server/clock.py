"""The current time, in milliseconds since 1970 (UTC), like every time in the protocol."""

import time
from datetime import UTC, datetime


def now_ms() -> int:
    """The current time."""
    return time.time_ns() // 1_000_000


def iso(ms: int) -> str:
    """A time as ISO 8601 in UTC, e.g. ``2026-11-08T07:31:04Z``."""
    return datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
