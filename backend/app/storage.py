"""S3-backed blob storage for copa file attachments.

The bytes for a file block live in a private S3 bucket; the backend never sees
them. Instead it mints short-lived presigned URLs so the client uploads/downloads
directly to S3. Signing happens with the ECS task role's credentials (picked up
by boto3 automatically), so the task role must hold the operations it signs.

When ``s3_bucket`` is unset the helpers raise ``StorageNotConfigured`` and the
file endpoints surface a 503 — attachments simply stay local-only.
"""

from __future__ import annotations

from functools import lru_cache

import boto3

from app.config import get_settings

# Presigned URLs are valid for 15 minutes — long enough for a large upload to
# start, short enough to limit replay if a URL leaks.
_URL_TTL_SECONDS = 900


class StorageNotConfigured(RuntimeError):
    """Raised when an S3 operation is attempted without a configured bucket."""


@lru_cache
def _client():
    settings = get_settings()
    return boto3.client("s3", region_name=settings.aws_region or None)


def is_configured() -> bool:
    return bool(get_settings().s3_bucket)


def _bucket() -> str:
    bucket = get_settings().s3_bucket
    if not bucket:
        raise StorageNotConfigured("S3_BUCKET is not set")
    return bucket


def presign_put(key: str, content_type: str | None) -> str:
    """A presigned URL the client PUTs raw bytes to."""
    params = {"Bucket": _bucket(), "Key": key}
    if content_type:
        params["ContentType"] = content_type
    return _client().generate_presigned_url(
        "put_object", Params=params, ExpiresIn=_URL_TTL_SECONDS
    )


def get_object_bytes(key: str) -> bytes:
    """Read an object's bytes directly.

    The one place the backend handles file bytes at all: publishing inlines a
    note's images into the fragment it sends the portfolio, which cannot resolve
    a reference or read a private object. Blocking — call it off the event loop.
    """
    return _client().get_object(Bucket=_bucket(), Key=key)["Body"].read()


def delete_object(key: str) -> None:
    """Remove an object for good.

    Used only by the note-image purge, once a tombstone has outlived its grace
    period. The ECS task role has to hold ``s3:DeleteObject`` for this — it did
    not until this shipped, which needs a hand-run ``terraform apply``, because
    CI never runs terraform.
    """
    _client().delete_object(Bucket=_bucket(), Key=key)


def presign_get(key: str) -> str:
    """A presigned URL the client GETs the bytes from."""
    return _client().generate_presigned_url(
        "get_object",
        Params={"Bucket": _bucket(), "Key": key},
        ExpiresIn=_URL_TTL_SECONDS,
    )
