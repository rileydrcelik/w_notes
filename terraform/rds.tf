# RDS PostgreSQL — the managed database, private (no public access).

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${local.name}-db" }
}

resource "aws_db_instance" "main" {
  identifier     = "${local.name}-db"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage = var.db_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  multi_az                = false # flip to true for prod HA (roughly doubles DB cost)
  backup_retention_period = 7
  deletion_protection     = false # set true once you have real data you can't lose

  # Dev convenience: don't force a final snapshot on destroy. For prod, set this
  # false and give final_snapshot_identifier a name so a teardown is recoverable.
  skip_final_snapshot = true

  tags = { Name = "${local.name}-db" }
}
