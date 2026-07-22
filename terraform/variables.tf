# All the knobs for the stack. Fill the ones without defaults in terraform.tfvars
# (copy terraform.tfvars.example). Sensitive values won't be printed in plan output.

variable "project" {
  type        = string
  default     = "wnotes"
  description = "Name prefix applied to resources and tags."
}

variable "region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region for the whole stack."
}

# ---- DNS (Cloudflare) ----

variable "domain_name" {
  type        = string
  description = "Your apex domain, e.g. example.com (the zone you manage in Cloudflare)."
}

variable "api_subdomain" {
  type        = string
  default     = "api"
  description = "Subdomain for the API; combined with domain_name -> api.example.com."
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare Zone ID for domain_name (Cloudflare dashboard -> your domain -> Overview, right sidebar)."
}

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare Account ID (dashboard -> your domain -> Overview, right sidebar). Required to create the Tunnel."
}

variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  description = "Cloudflare API token. Needs Zone:DNS:Edit for this zone AND Account:Cloudflare Tunnel:Edit (to create the tunnel)."
}

# ---- Compute (ECS Fargate) ----

variable "container_image" {
  type        = string
  default     = ""
  description = "Image the ECS task runs. Leave empty to default to '<this-stack's-ECR-repo>:latest'."
}

variable "desired_count" {
  type        = number
  default     = 1
  description = "Number of Fargate tasks. Keep at 1 until migrations are split out of container boot."
}

variable "task_cpu" {
  type        = number
  default     = 256 # 0.25 vCPU
  description = "Fargate task CPU units."
}

variable "task_memory" {
  type        = number
  default     = 512 # MiB
  description = "Fargate task memory (MiB)."
}

# ---- Database (RDS Postgres) ----

variable "db_instance_class" {
  type        = string
  default     = "db.t4g.micro"
  description = "RDS instance class."
}

variable "db_allocated_storage" {
  type        = number
  default     = 20
  description = "RDS storage in GiB."
}

variable "db_name" {
  type        = string
  default     = "wnotes"
  description = "Initial database name."
}

variable "db_username" {
  type        = string
  default     = "wnotes"
  description = "RDS master username."
}

# ---- App secrets (injected into the task from Secrets Manager) ----

variable "sentry_dsn" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Backend Sentry DSN. Empty => Sentry stays disabled and no secret is created."
}

variable "firebase_credentials_json" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Firebase service-account JSON (the whole file's contents). Empty => Firebase auth disabled."
}

variable "sentry_api_token" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Sentry REST API token (internal integration) for the /sentry issue proxy. Empty => the /sentry endpoints return 503."
}

variable "github_token" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Fine-grained GitHub PAT for the /sentry/autofix endpoints (fires repository_dispatch at autofix_repo and reads back the PR). Needs Contents R/W + Pull requests R + Actions R/W on the target repo. Empty => autofix returns 503."
}

variable "autofix_repo" {
  type        = string
  default     = ""
  description = "owner/name of the repo autofix dispatches target, e.g. \"rileydrcelik/aiko\". Empty => autofix disabled."
}

# ---- Web client (CORS) ----

variable "web_origins" {
  type        = list(string)
  default     = ["*"]
  description = <<-EOT
    Browser origins allowed to call the API and to transfer attachment bytes
    to/from S3 (CORS). Native apps don't enforce CORS, so this only affects the
    web client. Defaults to ["*"] so the web app works before its host is known;
    tighten to the deployed origin(s) (e.g. ["https://app.example.com"]) later.
  EOT
}

# ---- Publish notes to the portfolio website ----
#
# All three must be set or publishing stays off entirely (fail closed) and note
# sync behaves exactly as it did before the feature existed.

variable "portfolio_api_base" {
  type        = string
  default     = ""
  description = "Base URL of the portfolio API that receives embedded-note updates, e.g. \"https://portfolio2-production-0509.up.railway.app\". Empty => publishing disabled."
}

variable "portfolio_ingest_secret" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Shared secret for the portfolio's note endpoints. Authenticates both the outbound push of note updates and the portfolio's reads of /embed/notes. Must equal NOTES_INGEST_SECRET on the portfolio side. Empty => publishing disabled."
}

variable "publisher_emails" {
  type        = string
  default     = ""
  description = "Comma-separated account emails allowed to publish, matched against users.email. This API is multi-tenant: without it, any account could put posts on the site owner's portfolio. Empty => nobody can publish."
}
