# Bootstrap: creates the S3 bucket that stores the *main* stack's Terraform state.
#
# This is a chicken-and-egg fix: the main stack keeps its state in S3, but the
# bucket has to exist first. So this tiny stack runs ONCE with local state to
# create that bucket, and from then on you never touch it again.
#
#   cd terraform/bootstrap
#   terraform init
#   terraform apply -var state_bucket_name=wnotes-tfstate-<something-unique>
#
# Then copy the bucket name into ../backend.hcl and init the main stack.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "state_bucket_name" {
  type        = string
  description = "Globally-unique S3 bucket name for Terraform state."
}

resource "aws_s3_bucket" "tfstate" {
  bucket = var.state_bucket_name
}

# Versioning means a corrupted/clobbered state file can be rolled back.
resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# State can contain secrets — never let this bucket be public.
resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "state_bucket_name" {
  value = aws_s3_bucket.tfstate.id
}
