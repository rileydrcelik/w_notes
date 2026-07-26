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

    # Fine-grained GitHub PAT used by the /sentry/autofix endpoints to fire a
    # `repository_dispatch` at `autofix_repo` and read back the resulting PR. Kept
    # server-side (SSM) and never shipped in the app bundle. Empty => the autofix
    # endpoints return 503. Needs Contents R/W + Pull requests R + Actions R/W on
    # the target repo.
    github_token: str = ""

    # "owner/name" of the repo autofix dispatches target (e.g. "rileydrcelik/aiko").
    # Empty (with token) => autofix disabled.
    autofix_repo: str = ""

    # Comma-separated Sentry project slugs whose code actually lives in
    # `autofix_repo` (e.g. "w-notes-fastapi,w-notes-rn" — one repo, several
    # projects). A note for any *other* project must name its own repo, or the
    # request is refused: the fallback would otherwise dispatch an agent at this
    # repo to fix a bug that lives in a different codebase. Empty => unverified,
    # and the fallback applies to every project (the pre-guard behaviour).
    autofix_projects: str = ""

    # Base URL of the GitHub REST API. Overridable for GitHub Enterprise.
    github_api_base: str = "https://api.github.com"

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

    # --- Publish-to-portfolio -------------------------------------------------
    # Base URL of the portfolio API that hosts the public "notes" feed (e.g.
    # "https://api.rileydrcelik.com"). Empty => publishing is disabled entirely
    # and note sync behaves exactly as it did before the feature existed.
    portfolio_api_base: str = ""

    # Shared secret presented to the portfolio's /api/notes/ingest endpoint. The
    # portfolio's own write routes are gated on Firebase user tokens, which a
    # backend can't mint, so machine-to-machine ingest gets its own credential.
    # Empty => publishing is disabled (same as an empty base URL).
    portfolio_ingest_secret: str = ""

    # Comma-separated account emails allowed to publish. This is a multi-tenant
    # API: without an allowlist, *any* account could push posts onto the site
    # owner's portfolio just by flipping a note's `published` flag. Empty =>
    # nobody can publish (fail closed).
    #
    # Matched against `users.email`, which Firebase populates on sign-in, rather
    # than against `users.id`. The id is the more stable key, but it is a
    # server-minted UUID with no way to look it up: production RDS is not
    # publicly accessible, ECS Exec is not enabled, and there is no /me
    # endpoint. An allowlist nobody can populate is an allowlist that never gets
    # used correctly. An anonymous device-key account has no email and so can
    # never publish, which is the desired default.
    publisher_emails: str = ""

    @property
    def publisher_email_set(self) -> set[str]:
        """`publisher_emails` parsed into the set the sync hook checks.

        Lower-cased on both sides of the comparison: the local part of an
        address is technically case-sensitive, but no real provider treats it
        that way, and a capitalised letter in an env var silently disabling
        publishing would be a miserable thing to debug.
        """
        return {e.strip().lower() for e in self.publisher_emails.split(",") if e.strip()}

    @property
    def publishing_enabled(self) -> bool:
        """Publishing needs a destination, a credential, and at least one
        authorized publisher. Missing any of the three disables it silently."""
        return bool(
            self.portfolio_api_base
            and self.portfolio_ingest_secret
            and self.publisher_email_set
        )

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
