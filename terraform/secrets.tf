# Runtime secrets — SSM Parameter Store (SecureString).
#
# Parameter Store SecureStrings are free (standard tier) where Secrets Manager
# bills $0.40/secret/month, so the app's secrets live here. The ECS task
# references each by ARN and AWS injects the decrypted value as an env var at
# start; the plaintext never sits in the task definition.
#
# The DB password is generated here (so no human ever picks it) and reused both as
# the RDS master password and inside the DATABASE_URL connection string.

resource "random_password" "db" {
  length  = 32
  special = false # keep it URL-safe so it drops cleanly into DATABASE_URL
}

# DATABASE_URL — the asyncpg connection string the app reads.
resource "aws_ssm_parameter" "database_url" {
  name  = "/${local.name}/database-url"
  type  = "SecureString"
  value = "postgresql+asyncpg://${var.db_username}:${random_password.db.result}@${aws_db_instance.main.address}:5432/${var.db_name}"
}

# TUNNEL_TOKEN — credential the cloudflared sidecar uses to connect the tunnel.
resource "aws_ssm_parameter" "tunnel_token" {
  name  = "/${local.name}/tunnel-token"
  type  = "SecureString"
  value = cloudflare_zero_trust_tunnel_cloudflared.api.tunnel_token
}

# SENTRY_DSN — only created when a DSN was provided.
resource "aws_ssm_parameter" "sentry_dsn" {
  count = local.sentry_enabled ? 1 : 0
  name  = "/${local.name}/sentry-dsn"
  type  = "SecureString"
  value = var.sentry_dsn
}

# SENTRY_API_TOKEN — formerly the server-wide token behind the /sentry issue
# proxy. Nothing reads it since the proxy started acting as the caller's own
# token; retained so a rollback to an older image still finds it. Only created
# when provided.
resource "aws_ssm_parameter" "sentry_api_token" {
  count = local.sentry_api_enabled ? 1 : 0
  name  = "/${local.name}/sentry-api-token"
  type  = "SecureString"
  value = var.sentry_api_token
}

# GITHUB_TOKEN — fine-grained PAT for the /sentry/autofix dispatch; only created
# when both a token and a target repo were provided.
resource "aws_ssm_parameter" "github_token" {
  count = local.autofix_enabled ? 1 : 0
  name  = "/${local.name}/github-token"
  type  = "SecureString"
  value = var.github_token
}

# ANTHROPIC_API_KEY — Claude API key for the resume adder, which drafts a new
# resume entry server-side; only created when provided.
resource "aws_ssm_parameter" "anthropic_api_key" {
  count = local.anthropic_enabled ? 1 : 0
  name  = "/${local.name}/anthropic-api-key"
  type  = "SecureString"
  value = var.anthropic_api_key
}

# APP_SECRET_KEY — encrypts every credential users store against their own
# account (backend/app/crypto.py): their Anthropic API key, and their GitHub and
# Sentry provider tokens. SecureString like every other credential here, but note
# what makes this one different: it is the key that protects *other people's*
# credentials, so losing it is not recoverable from a database backup.
#
# The per-user provider tokens were originally written against a second key of
# their own (`credential_encryption_key`). They share this one instead — one key,
# one module, one thing to rotate. It matters operationally as well as
# aesthetically: this parameter is already applied and already wired into the
# task definition, so per-user tokens shipped without a terraform change.
resource "aws_ssm_parameter" "app_secret_key" {
  count = local.app_secret_enabled ? 1 : 0
  name  = "/${local.name}/app-secret-key"
  type  = "SecureString"
  value = var.app_secret_key
}

# APP_SECRET_KEY_OLD — the previous key during a rotation; only created while one
# is in flight, so the usual plan is empty.
#
# ⚠ Rotating `app_secret_key` without this makes every stored credential
# undecryptable at once — every user's AI key and both provider tokens — and the
# sealed columns are the only copy. To rotate deliberately: put the current value
# in `app_secret_key_old`, set the new one in `app_secret_key`, apply. Reads try
# the current key and fall back to the old, and each row re-seals under the new
# key the next time it is written. Drop the old value once they all have.
resource "aws_ssm_parameter" "app_secret_key_old" {
  count = local.app_secret_rotation_in_progress ? 1 : 0
  name  = "/${local.name}/app-secret-key-old"
  type  = "SecureString"
  value = var.app_secret_key_old
}

# FIREBASE_CREDENTIALS — the service-account JSON; only created when provided.
resource "aws_ssm_parameter" "firebase" {
  count = local.firebase_enabled ? 1 : 0
  name  = "/${local.name}/firebase-credentials"
  type  = "SecureString"
  value = var.firebase_credentials_json
}

# PORTFOLIO_INGEST_SECRET — shared secret for the portfolio's note endpoints;
# only created when publishing is fully configured.
resource "aws_ssm_parameter" "portfolio_ingest_secret" {
  count = local.publishing_enabled ? 1 : 0
  name  = "/${local.name}/portfolio-ingest-secret"
  type  = "SecureString"
  value = var.portfolio_ingest_secret
}
