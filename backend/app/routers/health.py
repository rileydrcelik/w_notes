"""Liveness / readiness probe."""

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(session: AsyncSession = Depends(get_session)) -> dict[str, str]:
    # A trivial query proves the pool can reach Postgres, not just that the
    # process is up.
    await session.execute(text("SELECT 1"))
    return {"status": "ok"}
