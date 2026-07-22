# GitHub Actions deploy identity.
#
# Lets the `Deploy backend` workflow push an image to ECR and roll the ECS
# service, without any long-lived AWS key sitting in the repo's secrets. GitHub
# mints a short-lived OIDC token per job; AWS trades it for temporary
# credentials, and the trust policy below decides who may do that.
#
# The trust is deliberately narrow: this one repo, and only workflows running on
# `main`. A pull request from a fork gets `ref:refs/pull/...` and is refused —
# which matters here, because autofix branches are written by an LLM.
#
# Empty `github_deploy_repo` => none of this is created and deploys stay manual.

locals {
  github_deploy_enabled = var.github_deploy_repo != ""
}

# One OIDC provider per AWS account. If the account already has one for GitHub
# (from another project), `terraform apply` fails with EntityAlreadyExists —
# import it instead:
#   terraform import aws_iam_openid_connect_provider.github \
#     arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com
resource "aws_iam_openid_connect_provider" "github" {
  count = local.github_deploy_enabled ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # AWS verifies GitHub's certificate against its own trusted CA store now, so
  # this value is no longer load-bearing — but the API still wants it present.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = local.tags
}

data "aws_iam_policy_document" "github_assume" {
  count = local.github_deploy_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # `sub` carries the workflow's origin. Pinning it to refs/heads/main is what
    # stops an unmerged branch — autofix or otherwise — from assuming this role.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_deploy_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  count = local.github_deploy_enabled ? 1 : 0

  name               = "${local.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume[0].json
  tags               = local.tags
}

# What a deploy does: put an image in this stack's ECR repo, register a task
# definition revision pointing at that exact image digest, and roll the service
# onto it.
#
# The per-SHA revision is what makes rollback real. ECS's circuit breaker rolls
# back to the *previous task definition revision*, so if every deploy reused one
# revision pinned to `:latest`, "rollback" would redeploy the same broken bytes.
data "aws_iam_policy_document" "github_deploy" {
  count = local.github_deploy_enabled ? 1 : 0

  # The login token is account-wide by nature; it grants nothing on its own.
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      # Read actions too: the build pulls previous layers for caching, and
      # rollback re-tags an existing digest rather than rebuilding it.
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.api.arn]
  }

  statement {
    sid = "EcsDeploy"
    actions = [
      "ecs:UpdateService",
      "ecs:DescribeServices",
    ]
    resources = [aws_ecs_service.api.id]
  }

  # RegisterTaskDefinition takes no resource ARN — the revision doesn't exist
  # yet — so it can't be scoped. Describe is scoped to this family's revisions.
  statement {
    sid       = "EcsRegisterTaskDefinition"
    actions   = ["ecs:RegisterTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "EcsDescribeTaskDefinition"
    actions   = ["ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }

  # Registering a revision means naming the roles the task assumes, which AWS
  # treats as passing them. Scoped to exactly these two roles: a deploy can
  # reuse the stack's identities, never grant the task a more privileged one.
  statement {
    sid     = "PassTaskRoles"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.execution.arn,
      aws_iam_role.task.arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  count = local.github_deploy_enabled ? 1 : 0

  name   = "${local.name}-github-deploy"
  role   = aws_iam_role.github_deploy[0].id
  policy = data.aws_iam_policy_document.github_deploy[0].json
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE secret in GitHub (repo → Settings → Secrets)."
  value       = local.github_deploy_enabled ? aws_iam_role.github_deploy[0].arn : null
}
