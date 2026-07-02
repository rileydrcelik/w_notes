locals {
  name     = var.project
  api_fqdn = "${var.api_subdomain}.${var.domain_name}"

  tags = {
    Project   = var.project
    ManagedBy = "terraform"
  }

  # Default the container image to this stack's own ECR repo if not overridden.
  container_image = var.container_image != "" ? var.container_image : "${aws_ecr_repository.api.repository_url}:latest"

  # Feature flags driven by whether the secret values were supplied.
  sentry_enabled     = var.sentry_dsn != ""
  sentry_api_enabled = var.sentry_api_token != ""
  firebase_enabled   = var.firebase_credentials_json != ""
  # Autofix needs both a GitHub token (to dispatch/read PRs) and a target repo.
  autofix_enabled = var.github_token != "" && var.autofix_repo != ""
}
