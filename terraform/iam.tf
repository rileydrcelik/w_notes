# IAM roles for the ECS task. Two distinct roles, by design:
#
# - execution role: used by the ECS *agent* to pull the image from ECR, write
#   logs, and fetch the Secrets Manager values to inject. (Infrastructure plumbing.)
# - task role: the identity your *application code* runs as. The app doesn't call
#   any AWS APIs today, so this stays empty — but it's the right place to grant
#   future permissions (e.g. S3 for attachments) without over-privileging the agent.

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ---- Execution role ----

resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# AWS-managed policy covering ECR pulls + CloudWatch Logs.
resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow reading exactly the SSM parameters this task injects (least privilege).
# Decryption uses the AWS-managed `alias/aws/ssm` key, which grants account
# principals access via SSM, so no explicit kms:Decrypt statement is needed.
data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions = ["ssm:GetParameters"]
    resources = concat(
      [aws_ssm_parameter.database_url.arn, aws_ssm_parameter.tunnel_token.arn],
      local.sentry_enabled ? [aws_ssm_parameter.sentry_dsn[0].arn] : [],
      local.sentry_api_enabled ? [aws_ssm_parameter.sentry_api_token[0].arn] : [],
      local.autofix_enabled ? [aws_ssm_parameter.github_token[0].arn] : [],
      local.firebase_enabled ? [aws_ssm_parameter.firebase[0].arn] : [],
      local.publishing_enabled ? [aws_ssm_parameter.portfolio_ingest_secret[0].arn] : [],
    )
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "${local.name}-read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

# ---- Task (application) role ----

resource "aws_iam_role" "task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# The app presigns S3 upload/download URLs as this role, so it must hold the
# operations it signs. Scoped to the attachments bucket's objects only.
data "aws_iam_policy_document" "task_s3" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.attachments.arn}/*"]
  }
}

resource "aws_iam_role_policy" "task_s3" {
  name   = "${local.name}-attachments-s3"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_s3.json
}
