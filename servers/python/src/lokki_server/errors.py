"""Errors as the protocol describes them: ``{"error": "<code>", "message": "…"}``."""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from lokki_server.models import ErrorBody

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


# Errors as the API docs show them: (status, code, message, extra fields)
_KNOWN: dict[str, tuple[int, str, dict[str, Any]]] = {
    "invalid_request": (400, "rows.0.key: String should match pattern '^[A-Za-z0-9_-]{22}$'", {}),
    "unauthorized": (401, "This token isn't valid on this server.", {}),
    "forbidden": (403, "This token can only read.", {}),
    "behind": (409, "Pull first: the vault has changed.", {"head": 1050}),
    "keyring_behind": (
        409,
        "The keyring has changed; read the vault again.",
        {"keyring_version": 4},
    ),
    "different_vault": (409, "This server holds a different vault.", {"keyring_version": 4}),
    "name_taken": (409, "There's a vault called conformance already.", {}),
    "too_large": (413, "A push can have at most 500 rows.", {}),
}
_STATUS_TEXT = {
    400: "The request isn't valid",
    401: "No token, or one this server doesn't know",
    403: "The token can only read",
    409: "Conflict: someone else wrote first, or this isn't the same vault",
    413: "Too many rows, or a row or keyring too large",
}


def documented(*codes: str) -> dict[int | str, dict[str, Any]]:
    """The `responses` of an endpoint that can give these errors, for the API docs."""
    responses: dict[int | str, dict[str, Any]] = {}
    for code in codes:
        status, message, extra = _KNOWN[code]
        error = "behind" if code == "keyring_behind" else code
        entry = responses.setdefault(
            status,
            {
                "model": ErrorBody,
                "description": _STATUS_TEXT[status],
                "content": {"application/json": {"examples": {}}},
            },
        )
        entry["content"]["application/json"]["examples"][code] = {
            "summary": error,
            "value": {"error": error, "message": message, **extra},
        }
    return responses
