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
    #
    # This is the *operator's* token for this deployment's own autofix pipeline.
    # It is deliberately NOT a fallback for the user-facing /github routes: those
    # read the caller's own credential (see `app/credentials.py`), because a
    # shared token meant every account browsed the operator's repos — which is
    # exactly what happened in the field before per-user credentials existed.
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

    # Anthropic API key used by POST /resume/entry, which asks Claude to draft a
    # new resume entry in the document's own LaTeX style. Kept server-side (SSM)
    # and never shipped in the app bundle — a key in the client bundle is a key
    # anyone can read. Empty => that endpoint returns 503 and nothing else in the
    # API changes.
    anthropic_api_key: str = ""

    # Which model drafts and edits entries, and how long to wait for it.
    #
    # Sonnet, not Opus. The job is narrow and the context does most of the work:
    # the document to imitate is right there, the form is filled in, and the
    # answer is a few lines of LaTeX in a schema the API enforces. Opus's headroom
    # went unused on a task that specified this tightly, and someone is watching a
    # spinner while it runs.
    #
    # Everything the endpoints rely on is available here — structured outputs,
    # `effort`, and the `web_fetch_20260209` tool that reads context links — so
    # this is a straight swap. Overridable per-environment, so a deployment can
    # move it without a code change.
    anthropic_model: str = "claude-sonnet-5"
    anthropic_timeout_seconds: float = 60.0

    # Comma-separated account emails that may spend `anthropic_api_key` — the
    # server's own key, and the server's own bill.
    #
    # Everyone else brings their own, stored per account (encrypted, see
    # `app/crypto.py`) and used only for their own requests. That is the whole
    # point of the split: these endpoints run a frontier model over a whole
    # resume, several times per press for the tailor, and this is a multi-tenant
    # API. Without the split, one person's enthusiasm is the operator's invoice.
    #
    # Matched against `users.email` exactly like `publisher_emails`, and for the
    # same reason — the user id is a server-minted UUID nobody can look up.
    # Empty => nobody rides free, including the operator, which is the safe
    # default for a fork of this deployment.
    ai_owner_emails: str = ""

    # Fernet key (32 url-safe base64-encoded bytes) that encrypts every credential
    # users store here: their Anthropic API key, and their GitHub and Sentry
    # provider tokens. SSM in a deployment, `.env` locally. Generate with:
    #     python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    #
    # Empty fails closed, in two directions: users cannot save a key at all, only
    # `ai_owner_emails` accounts can use the AI endpoints, and the GitHub/Sentry
    # plugins go dark rather than falling back to a shared token. Better an
    # unavailable plugin than user PATs written to the database in plaintext.
    app_secret_key: str = ""

    # The previous `app_secret_key`, during a rotation. Reads try the current key
    # and then this one; writes always use the current key, so a row migrates the
    # next time it is written. Drop this once every row has been rewritten.
    #
    # Rotating without it orphans every stored credential — each user's AI key and
    # provider tokens become unreadable at once, and the sealed columns are the
    # only copy.
    app_secret_key_old: str = ""

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

    # How /latex/compile runs TeX. latexmk drives the engine (a resume needs two
    # or three passes to settle its references) and picks pdflatex or xelatex per
    # request; both are baked into the image, see backend/Dockerfile.
    latexmk_path: str = "latexmk"
    # The unprivileged account a compile drops to. It exists only in the image,
    # so off-image runs (a dev machine, the test suite) keep whoever they are —
    # see `_compile_user` in routers/latex.py.
    latex_user: str = "latex"
    # How that drop is performed. asyncio's subprocess API rejects `user=`/
    # `group=` (unlike subprocess.Popen), so the command is wrapped instead.
    # util-linux, present in the Debian base.
    setpriv_path: str = "setpriv"

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
    def ai_owner_email_set(self) -> set[str]:
        """`ai_owner_emails` parsed, lower-cased on both sides — see
        `publisher_email_set`, which this deliberately mirrors."""
        return {e.strip().lower() for e in self.ai_owner_emails.split(",") if e.strip()}

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
