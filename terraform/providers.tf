# Provider configuration. Credentials are read from the environment, never hard-
# coded: AWS from your usual `aws configure` / env vars, Cloudflare from a token
# variable (set it via TF_VAR_cloudflare_api_token or terraform.tfvars).

provider "aws" {
  region = var.region

  # Every resource that supports tags gets these automatically.
  default_tags {
    tags = local.tags
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
