# API

FastAPI, in `backend/`. Interactive docs are at `/docs` on any running instance;
production is `https://api.w-notes.app`.

## Auth

One header, two shapes, told apart by structure:

```
Authorization: Bearer <firebase-id-token>   # a JWT — a signed-in account
Authorization: Bearer <device-key>          # a UUID — an anonymous device
```

The server verifies a Firebase token with the Admin SDK and maps it to a user by
uid. For a device key it get-or-creates a user row. With `firebase_credentials`
unset, Firebase auth is off and only device keys are accepted.

`/embed/*` is the exception: it is called by the portfolio *backend*, and
authenticates with a shared secret instead.

## Endpoints

### Sync — `app/routers/sync.py`

| | |
|---|---|
| `POST /sync/push` | Upload dirty rows. Returns the new cursor. |
| `GET /sync/pull` | Everything changed since `since`, paged (`has_more`). |

### Files — `app/routers/files.py`

| | |
|---|---|
| `POST /files/upload-url` | A short-lived presigned S3 PUT URL. |
| `POST /files/download-url` | A short-lived presigned S3 GET URL. |

Bytes never pass through the API. Needs `s3_bucket`; without it, 503, and
attachments stay local-only.

### Account — `app/routers/me.py`, `app/routers/credentials.py`

| | |
|---|---|
| `GET`/`PUT`/`DELETE /me/ai-key` | Your Anthropic key. Stored encrypted; only ever reported as present or absent. |
| `GET /credentials` | Which provider tokens you have stored. |
| `PUT /credentials/{provider}` | Store a GitHub or Sentry token. |
| `DELETE /credentials/{provider}` | Remove one. |

### GitHub — `app/routers/github_issues.py`

`GET /github/repos`, `/issue-count`, `/issues`, `/issues/{number}`,
`/issues/{number}/comments`, `/labels`, `/assignees`, `/milestones`;
`POST /github/issues` (create), `PATCH /github/issues/{number}` (state and
fields), `POST /github/issues/{number}/comments`.

All calls use **the caller's own** stored token. The operator's `github_token` is
deliberately not a fallback: a shared token meant every account browsed the
operator's repos.

### Sentry — `app/routers/sentry.py`

`GET /sentry/issues`, `/issues/{id}`, `/projects`, `/issues/{id}/latest-event`;
`POST /sentry/issues/{id}/resolve`; `POST /sentry/autofix` (202) and
`GET /sentry/autofix/status`.

Autofix fires a `repository_dispatch` at `autofix_repo` and reads back the
resulting PR. A note for a project not listed in `autofix_projects` must name its
own repo, or the request is refused — otherwise the agent would be sent to fix a
bug living in a different codebase.

### LaTeX and resume — `app/routers/latex.py`, `app/routers/resume.py`

| | |
|---|---|
| `POST /latex/compile` | Compile LaTeX to PDF. Runs sandboxed under `setpriv` + `prlimit`. |
| `POST /resume/job-posting` | Read a posting from a URL **or** pasted text. |
| `POST /resume/tailor` | Aim a resume at one posting. Returns a whole document. |
| `POST /resume/harden` | Aim a resume at a job title. |
| `POST /resume/entry` | Draft one new entry, insert-only. |
| `POST /resume/edit` | Edit a selected region of the source. |

These spend an Anthropic key — **the caller's own**, unless their email is in
`ai_owner_emails`. No key and no exemption returns 402.

> The Anthropic SDK retries timeouts (default 2), so wall clock is the timeout
> times three. Set `max_retries`, stream, and keep the server's own deadline
> inside the client's, or a slow call outlives the request and bills three times.

### Portfolio — `app/publisher.py`, `app/routers/embed.py`

`GET /embed/notes` and `GET /embed/notes/{id}` let the portfolio's admin list
and read publishable notes. Publishing itself is not an endpoint — `/sync/push`
calls the publisher after its flush, in a background task, so a portfolio outage
can never fail someone's sync.

### Health

`GET /health` → `{"status":"ok"}`.

## Settings

Loaded from the environment or `.env` (`app/config.py`). In production they come
from SSM Parameter Store. **Empty means the feature is off**, never that it falls
back to something shared.

| Setting | For |
|---|---|
| `database_url` | Postgres (asyncpg URL). |
| `firebase_credentials` | Service-account JSON, or a path to it. Empty → device keys only. |
| `app_secret_key` | Fernet key encrypting every stored credential. Empty → nobody can save a token, and the plugins go dark. |
| `app_secret_key_old` | The previous key, during a rotation. Reads try both; writes use the current one. |
| `s3_bucket`, `aws_region`, `max_upload_bytes` | Copa file bytes. |
| `sentry_dsn`, `env` | Error reporting *from* the backend. |
| `sentry_api_token`, `sentry_api_base` | Reading Sentry issues for the plugin. Unrelated to `sentry_dsn`. |
| `github_token`, `autofix_repo`, `autofix_projects`, `github_api_base` | The autofix pipeline only. |
| `anthropic_api_key`, `anthropic_model`, `anthropic_timeout_seconds` | The server's own AI key and model. |
| `ai_owner_emails` | Emails allowed to spend the server's key. Empty → nobody, including the operator. |
| `portfolio_api_base`, `portfolio_ingest_secret`, `publisher_emails` | Publishing to the portfolio site. |
| `latexmk_path`, `latex_user`, `setpriv_path`, `prlimit_path`, `pdftoppm_path`, `raster_memory_bytes` | The LaTeX sandbox. |
| `cors_origins` | Origins the web app is served from. |

> Rotating `app_secret_key` without setting `app_secret_key_old` orphans every
> stored credential at once. The sealed columns are the only copy.
