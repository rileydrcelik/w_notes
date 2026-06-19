"""File-attachment endpoints — presigned S3 URLs for copa file blocks.

The client never sends bytes through this API; it asks for a short-lived
presigned URL and transfers directly to/from S3.

- ``POST /files/upload-url`` — mints a fresh object key and returns a presigned
  PUT. Any authenticated user may request one (the key is a fresh UUID, so there
  is nothing to authorize against yet).
- ``POST /files/download-url`` — returns a presigned GET, but only after
  confirming the caller owns a ``copa_items`` row that references the key. This
  is what prevents one user from reading another's objects.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models import CopaItem, User
from app.storage import StorageNotConfigured, is_configured, presign_get, presign_put

router = APIRouter(prefix="/files", tags=["files"])


class UploadUrlRequest(BaseModel):
    mime_type: str | None = None


class UploadUrlResponse(BaseModel):
    key: str
    url: str


class DownloadUrlRequest(BaseModel):
    key: str


class DownloadUrlResponse(BaseModel):
    url: str


def _require_storage() -> None:
    if not is_configured():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "File storage is not configured"
        )


@router.post("/upload-url", response_model=UploadUrlResponse)
async def upload_url(
    payload: UploadUrlRequest,
    user: User = Depends(get_current_user),
) -> UploadUrlResponse:
    _require_storage()
    key = f"attachments/{uuid.uuid4()}"
    try:
        url = presign_put(key, payload.mime_type)
    except StorageNotConfigured:
        _require_storage()  # surface as 503
        raise
    return UploadUrlResponse(key=key, url=url)


@router.post("/download-url", response_model=DownloadUrlResponse)
async def download_url(
    payload: DownloadUrlRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> DownloadUrlResponse:
    _require_storage()
    # Authorize: the caller must own a copa row pointing at this key.
    owned = await session.scalar(
        select(CopaItem.id).where(
            CopaItem.user_id == user.id, CopaItem.remote_key == payload.key
        )
    )
    if owned is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your file")
    return DownloadUrlResponse(url=presign_get(payload.key))
