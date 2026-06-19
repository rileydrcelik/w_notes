# Private S3 bucket holding copa file-attachment bytes. The app never serves the
# bytes itself — it mints short-lived presigned URLs and the client transfers
# directly to/from S3. The bucket stays fully private; access is only ever via a
# presigned URL signed by the ECS task role (see the s3 policy in iam.tf).

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "attachments" {
  # Bucket names are globally unique; suffix with the account id to avoid clashes.
  bucket = "${local.name}-attachments-${data.aws_caller_identity.current.account_id}"
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket                  = aws_s3_bucket.attachments.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Reclaim storage from uploads that were started but never completed.
resource "aws_s3_bucket_lifecycle_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
