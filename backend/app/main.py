"""FastAPI application entrypoint + Sentry wiring."""

from __future__ import annotations

import sentry_sdk
from fastapi import FastAPI
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration

from app.config import get_settings
from app.routers import files, health, sync

settings = get_settings()

# Empty DSN => init is skipped entirely, so the app runs fine without Sentry.
if settings.sentry_dsn:
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.env,
        integrations=[FastApiIntegration(), SqlalchemyIntegration()],
        # Full sampling in dev; dial down in production.
        traces_sample_rate=1.0 if settings.env == "development" else 0.2,
        send_default_pii=False,
    )

app = FastAPI(title="w_notes sync", version="0.1.0")

app.include_router(health.router)
app.include_router(sync.router)
app.include_router(files.router)
