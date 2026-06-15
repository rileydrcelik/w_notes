# Security groups — the per-resource firewalls. Traffic flows:
#
#   internet --(Cloudflare Tunnel, outbound)--> ECS task --5432--> RDS
#
# Ingress reaches the app only through the cloudflared sidecar's outbound tunnel,
# so the task needs no inbound rule at all — just egress for the tunnel, Firebase,
# Sentry, and Postgres.

# ECS task: no inbound. Egress only (tunnel + Firebase/Sentry + Postgres).
resource "aws_security_group" "ecs" {
  name        = "${local.name}-ecs"
  description = "App container; no inbound, egress only (ingress via Cloudflare Tunnel)"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-ecs" }
}

# RDS: only accepts Postgres from the ECS tasks.
resource "aws_security_group" "rds" {
  name        = "${local.name}-rds"
  description = "Postgres; ingress from ECS tasks only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from ECS"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-rds" }
}
