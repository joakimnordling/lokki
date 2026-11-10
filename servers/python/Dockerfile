# The sync server as a container, e.g. for Cloud Run: docker build -t lokki-server servers/python
# Listens on $PORT (8080 on Cloud Run), and updates the database's tables when it starts.
FROM ghcr.io/astral-sh/uv:0.13 AS uv

FROM python:3.15-slim AS build
COPY --from=uv /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
# the dependencies first, so changing the server's code doesn't reinstall them
COPY pyproject.toml uv.lock README.md LICENSE ./
RUN uv sync --locked --no-dev --no-install-project --extra postgresql --extra firestore
COPY src ./src
RUN uv sync --locked --no-dev --no-editable --extra postgresql --extra firestore

FROM python:3.15-slim
RUN useradd --system --uid 10001 --no-create-home lokki
COPY --from=build /app/.venv /app/.venv
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1 PORT=8080
USER lokki
CMD ["lokki-server", "serve", "--host", "0.0.0.0"]
