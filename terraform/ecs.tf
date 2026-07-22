# ECS Fargate: the cluster, the task definition (what to run), and the service
# (keep N copies running). The task runs two containers: the app, and a
# `cloudflared` sidecar that connects the Cloudflare Tunnel for public ingress.

resource "aws_ecs_cluster" "main" {
  name = "${local.name}-cluster"
  tags = { Name = "${local.name}-cluster" }
}

# Make both Fargate capacity providers available so the service can run on Spot.
resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}-api"
  retention_in_days = 30
}

# App-container secrets, pulled from SSM by the execution role. Skip the optional
# ones that weren't configured.
locals {
  container_secrets = concat(
    [{ name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn }],
    local.sentry_enabled ? [{ name = "SENTRY_DSN", valueFrom = aws_ssm_parameter.sentry_dsn[0].arn }] : [],
    local.sentry_api_enabled ? [{ name = "SENTRY_API_TOKEN", valueFrom = aws_ssm_parameter.sentry_api_token[0].arn }] : [],
    local.autofix_enabled ? [{ name = "GITHUB_TOKEN", valueFrom = aws_ssm_parameter.github_token[0].arn }] : [],
    local.firebase_enabled ? [{ name = "FIREBASE_CREDENTIALS", valueFrom = aws_ssm_parameter.firebase[0].arn }] : [],
    local.publishing_enabled ? [{ name = "PORTFOLIO_INGEST_SECRET", valueFrom = aws_ssm_parameter.portfolio_ingest_secret[0].arn }] : [],
  )
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = local.container_image
      essential = true

      portMappings = [{
        containerPort = 8000
        protocol      = "tcp"
      }]

      # Non-secret config. ENV drives Sentry sample rates + environment tag;
      # S3_BUCKET/AWS_REGION point boto3 at the attachments bucket for presigning.
      environment = [
        { name = "ENV", value = "production" },
        { name = "S3_BUCKET", value = aws_s3_bucket.attachments.bucket },
        { name = "AWS_REGION", value = var.region },
        # CORS allow-list for the web client (comma-separated). The S3 bucket
        # CORS in s3.tf must allow the same origins for byte transfers.
        { name = "CORS_ORIGINS", value = join(",", var.web_origins) },
        # Target repo for /sentry/autofix dispatches (empty => autofix disabled).
        { name = "AUTOFIX_REPO", value = var.autofix_repo },
        # Where embedded-note updates are pushed, and which accounts may
        # publish. The matching secret rides in `secrets` below; all three must
        # be set or the app disables publishing entirely.
        { name = "PORTFOLIO_API_BASE", value = var.portfolio_api_base },
        { name = "PUBLISHER_EMAILS", value = var.publisher_emails },
      ]

      # Secret config, pulled from SSM Parameter Store by the execution role.
      secrets = local.container_secrets

      # The image is python:slim (no curl), so health-check with python itself.
      healthCheck = {
        command     = ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://localhost:8000/health')\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 120 # room for `alembic upgrade head` on boot
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "api"
        }
      }
    },
    {
      # Cloudflare Tunnel connector. Dials out to Cloudflare's edge and proxies
      # api.<domain> to the app on localhost:8000. Token-only run (ingress rules
      # are managed remotely; see tunnel.tf).
      name      = "cloudflared"
      image     = "cloudflare/cloudflared:latest"
      essential = true
      command   = ["tunnel", "--no-autoupdate", "run"]

      secrets = [
        { name = "TUNNEL_TOKEN", valueFrom = aws_ssm_parameter.tunnel_token.arn }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "cloudflared"
        }
      }
    },
  ])
}

resource "aws_ecs_service" "api" {
  name            = "${local.name}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.desired_count

  # Run on Fargate Spot (~70% cheaper). A reclaimed task is replaced; at
  # desired_count = 1 that's brief downtime, acceptable for this stage.
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }

  network_configuration {
    # Public subnets + a public IP give the task free internet egress via the
    # internet gateway (no NAT). The task is not reachable inbound: its security
    # group has no ingress rules — public traffic arrives only via the tunnel's
    # outbound connection.
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  depends_on = [aws_ecs_cluster_capacity_providers.main]
}
