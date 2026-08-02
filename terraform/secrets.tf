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

# CREDENTIAL_ENCRYPTION_KEY — the Fernet key that app/crypto.py encrypts each
# user's GitHub/Sentry token with.
#
# Generated here rather than passed in, for the same reason as the DB password:
# no human picks it, and it never sits in a tfvars file on someone's laptop.
# Unconditional — the app fails closed without it, so a stack missing this key
# has working sync and dead GitHub/Sentry plugins.
#
# Fernet wants 32 bytes as *URL-safe* base64; `random_bytes` emits the standard
# alphabet, so translate the two characters that differ.
#
# ⚠ Replacing this resource makes every stored credential undecryptable and
# every user has to re-enter their token. To rotate deliberately, copy the
# current value into `credential_encryption_key_old` (reads fall back to it),
# apply, then taint this resource — rows re-encrypt as they are next written.
resource "random_bytes" "credential_encryption_key" {
  length = 32
}

resource "aws_ssm_parameter" "credential_encryption_key" {
  name  = "/${local.name}/credential-encryption-key"
  type  = "SecureString"
  value = replace(replace(random_bytes.credential_encryption_key.base64, "+", "-"), "/", "_")
}

# CREDENTIAL_ENCRYPTION_KEY_OLD — the previous key during a rotation; only
# created while one is in flight.
resource "aws_ssm_parameter" "credential_encryption_key_old" {
  count = local.credential_rotation_in_progress ? 1 : 0
  name  = "/${local.name}/credential-encryption-key-old"
  type  = "SecureString"
  value = var.credential_encryption_key_old
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
