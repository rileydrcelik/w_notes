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

# SENTRY_API_TOKEN — REST-API token for the /sentry issue proxy; only created
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
