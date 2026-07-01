"""Application settings, loaded from the environment (12-factor)."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # asyncpg connection URL. docker-compose injects this for the container.
    database_url: str = "postgresql+asyncpg://wnotes:wnotes@localhost:5432/wnotes"

    # Empty string => Sentry stays disabled (a no-op), so the app runs without it.
    sentry_dsn: str = ""

    # Free-form environment tag attached to Sentry events.
    env: str = "development"

    # Auth token for the Sentry *REST API* (an internal-integration token) used by
    # the /sentry proxy to read a project's issues on the client's behalf. Kept
    # server-side and never shipped in the app bundle. Empty => the proxy returns
    # 503. This is unrelated to `sentry_dsn` (which is for error *reporting*). The
    # org/project a note targets travel per-request, so one token can serve many
    # projects it has access to.
    sentry_api_token: str = ""

    # Base URL of the Sentry REST API. Overridable for self-hosted Sentry.
    sentry_api_base: str = "https://sentry.io/api/0"

    # Firebase service-account credential used to verify ID tokens: either a path
    # to the JSON file (local dev) or the JSON content itself (deployed — injected
    # from a secrets manager). Empty => Firebase auth is disabled and only
    # anonymous device keys are accepted.
    firebase_credentials: str = ""

    # S3 bucket holding copa file-attachment bytes, and the region to sign for.
    # Empty bucket => the file endpoints return 503 (attachments stay local-only).
    # boto3 picks up credentials from the ECS task role automatically.
    s3_bucket: str = ""
    aws_region: str = ""

    # Largest attachment we hand out an upload URL for (2 GB). Advisory: the v1
    # presigned PUT can't hard-enforce this, so the client checks size too.
    max_upload_bytes: int = 2 * 1024 * 1024 * 1024

    # Browser origins allowed to call the API (CORS). Native apps don't enforce
    # CORS so this only matters for the web client. Comma-separated list, or "*"
    # to allow any origin — safe here because auth is a bearer token, not a
    # cookie, so there are no ambient credentials to protect.
    cors_origins: str = "*"

    @property
    def cors_origin_list(self) -> list[str]:
        """`cors_origins` parsed into the list CORSMiddleware expects."""
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
