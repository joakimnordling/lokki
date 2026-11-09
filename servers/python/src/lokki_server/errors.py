"""
Errors as the protocol describes them: ``{"error": "<code>", "message": "…"}``.

Each error the API gives is made by one function below. The API raises what it returns, and the
API docs show what it returns as examples, so the two can't differ.
"""

from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from lokki_server.models import Behind, ErrorBody, KeyringConflict

Body = ErrorBody | Behind | KeyringConflict


class ApiError(Exception):
    """An error response: its status and body."""

    def __init__(
        self,
        status: int,
        body: Body,
    ) -> None:
        super().__init__(body.message)
        self.status = status
        self.body = body


def invalid_request(message: str) -> ApiError:
    return ApiError(
        400,
        ErrorBody(
            error="invalid_request",
            message=message,
        ),
    )


def unauthorized(message: str = "This token isn't valid on this server.") -> ApiError:
    return ApiError(
        401,
        ErrorBody(
            error="unauthorized",
            message=message,
        ),
    )


def forbidden() -> ApiError:
    return ApiError(
        403,
        ErrorBody(
            error="forbidden",
            message="This token can only read.",
        ),
    )


def behind(head: int) -> ApiError:
    return ApiError(
        409,
        Behind(
            error="behind",
            message="Pull first: the vault has changed.",
            head=head,
        ),
    )


def keyring_behind(keyring_version: int) -> ApiError:
    return ApiError(
        409,
        KeyringConflict(
            error="behind",
            message="The keyring has changed; read the vault again.",
            keyring_version=keyring_version,
        ),
    )


def different_vault(keyring_version: int) -> ApiError:
    return ApiError(
        409,
        KeyringConflict(
            error="different_vault",
            message="This server holds a different vault.",
            keyring_version=keyring_version,
        ),
    )


def name_taken(name: str) -> ApiError:
    return ApiError(
        409,
        ErrorBody(
            error="name_taken",
            message=f"There's a vault called {name} already.",
        ),
    )


def too_large(message: str) -> ApiError:
    return ApiError(
        413,
        ErrorBody(
            error="too_large",
            message=message,
        ),
    )


def internal() -> ApiError:
    return ApiError(
        500,
        ErrorBody(
            error="internal",
            message="Something went wrong on the server. Try again later.",
        ),
    )


def _respond(error: ApiError) -> JSONResponse:
    return JSONResponse(
        error.body.model_dump(),
        status_code=error.status,
        headers={"WWW-Authenticate": "Bearer"} if error.status == 401 else None,
    )


def install(app: FastAPI) -> None:
    """Make every error, including FastAPI's own and unexpected ones, use the protocol's format."""

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, exc: ApiError) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        return _respond(exc)

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        # Starlette's own, e.g. 404 and 405: the code is the status's name, e.g. not_found
        code = HTTPStatus(exc.status_code).phrase.lower().replace(" ", "_")
        return _respond(
            ApiError(
                exc.status_code,
                ErrorBody(
                    error=code,
                    message=str(exc.detail),
                ),
            )
        )

    @app.exception_handler(RequestValidationError)
    async def invalid(_request: Request, exc: RequestValidationError) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        problems = "; ".join(
            f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
        )
        return _respond(invalid_request(problems))

    @app.exception_handler(Exception)
    async def unexpected(_request: Request, _exc: Exception) -> JSONResponse:  # pyright: ignore[reportUnusedFunction]
        # Starlette still raises the exception afterwards, so the server logs its traceback;
        # the client gets no details.
        return _respond(internal())


# For the API docs

Responses = dict[int | str, dict[str, Any]]

# On every endpoint. Documenting `default` also keeps FastAPI from adding its own 422, which this
# server never sends (invalid requests get 400).
DEFAULT: Responses = {
    "default": {
        "model": ErrorBody,
        "description": "Any other error, in the same format: e.g. 404 unknown path, 405 wrong "
        "method, 429 too many requests (with Retry-After), or 500 a fault in the server",
        "content": {"application/json": {"example": internal().body.model_dump()}},
    }
}


def documented(*errors: ApiError) -> Responses:
    """An endpoint's `responses`: these errors, as examples under their status."""
    responses: Responses = {}
    for error in errors:
        entry = responses.setdefault(
            error.status,
            {
                "model": type(error.body),
                "description": HTTPStatus(error.status).phrase,
                "content": {"application/json": {"examples": {}}},
            },
        )
        entry["content"]["application/json"]["examples"][error.body.error] = {
            "value": error.body.model_dump(),
        }
    return responses
