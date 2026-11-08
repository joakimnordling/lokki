"""Errors as the protocol describes them: ``{"error": "<code>", "message": "…"}``."""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

_CODES = {
    400: "invalid_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "too_large",
}


class ApiError(Exception):
    """An error response, with extra fields (e.g. the current ``head`` on a conflict)."""

    def __init__(self, status: int, error: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.error = error
        self.message = message
        self.extra = extra


def _response(status: int, error: str, message: str, **extra: Any) -> JSONResponse:
    headers = {"WWW-Authenticate": "Bearer"} if status == 401 else None
    return JSONResponse(
        {"error": error, "message": message, **extra}, status_code=status, headers=headers
    )


def install(app: FastAPI) -> None:
    """Make every error, including FastAPI's own, use the protocol's format."""

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, exc: ApiError) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        return _response(exc.status, exc.error, exc.message, **exc.extra)

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        return _response(exc.status_code, _CODES.get(exc.status_code, "error"), str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def invalid(_request: Request, exc: RequestValidationError) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        problems = "; ".join(
            f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
        )
        return _response(400, "invalid_request", problems)
