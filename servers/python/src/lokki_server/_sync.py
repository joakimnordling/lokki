"""Running async functions from synchronous code, such as Typer commands."""

import asyncio
import functools
from collections.abc import Callable, Coroutine
from typing import Any


def async_to_sync[**P, R](func: Callable[P, Coroutine[Any, Any, R]]) -> Callable[P, R]:
    """
    Wrap an async function so it can be used as a sync (Typer) command.

    Typer commands must be plain sync callables. Decorate the async command with this so it runs to
    completion via ``asyncio.run``. ``functools.wraps`` keeps the original signature visible
    (``__wrapped__``), so Typer still derives the CLI parameters from the async function's
    annotations.
    """

    @functools.wraps(func)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        return asyncio.run(
            func(
                *args,
                **kwargs,
            )
        )

    return wrapper
