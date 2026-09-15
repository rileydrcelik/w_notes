"""Liveness / readiness probe."""

from fastapi import APIRouter
from sqlalchemy import text

from app.db import HealthSessionLocal

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    # A trivial query proves the pool can reach Postgres, not just that the
    # process is up.
    #
    # It runs on `health_engine`, not the request pool. Sharing the request pool
    # meant a full pool failed this probe first, so ECS killed the container for
    # being busy — which cleared nothing, since the pool was held by a stuck
    # transaction, and cost a sync outage on every restart. See app/db.py.
    async with HealthSessionLocal() as session:
        await session.execute(text("SELECT 1"))
    return {"status": "ok"}
