"""FastAPI application entrypoint + Sentry wiring."""

from __future__ import annotations

import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration

from app.config import get_settings
from app.routers import files, github_issues, health, sentry, sync

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

# CORS for the web client. The browser blocks cross-origin fetches (and their
# preflight OPTIONS) unless the API echoes these headers; native apps don't
# enforce CORS, so this is purely what unblocks web sync. allow_credentials stays
# False — auth rides an Authorization bearer header, not cookies — which also
# lets a "*" origin list work (the two are mutually exclusive in the spec).
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(sync.router)
app.include_router(files.router)
app.include_router(sentry.router)
app.include_router(github_issues.router)
