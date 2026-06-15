# Terraform + provider version pins, and the remote state backend.
#
# The backend block is intentionally empty ("partial configuration") — the bucket
# name lives in backend.hcl (which you create from backend.hcl.example) so it
# isn't hard-coded here. Wire it up with:
#
#   terraform init -backend-config=backend.hcl

terraform {
  required_version = ">= 1.10"

  backend "s3" {
    key          = "infra/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true # S3-native state locking (Terraform 1.10+, no DynamoDB needed)
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.40"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
