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
  sentry_enabled   = var.sentry_dsn != ""
  firebase_enabled = var.firebase_credentials_json != ""
}
