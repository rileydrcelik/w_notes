# FastAPI sync backend. Slim Python base; uvicorn serves the ASGI app.
FROM python:3.12-slim

WORKDIR /app

# System deps are minimal — asyncpg ships wheels, so no build toolchain needed.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# Install deps first so the layer caches across code edits.
COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install .

COPY . .

EXPOSE 8000

# Run migrations, then start the server. `alembic upgrade head` is idempotent.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
