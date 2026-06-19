output "api_url" {
  description = "Public API base URL — set this as EXPO_PUBLIC_API_URL in the app."
  value       = "https://${local.api_fqdn}"
}

output "tunnel_id" {
  description = "Cloudflare Tunnel ID (visible in Zero Trust > Networks > Tunnels)."
  value       = cloudflare_zero_trust_tunnel_cloudflared.api.id
}

output "ecr_repository_url" {
  description = "Push your Docker image here, then deploy."
  value       = aws_ecr_repository.api.repository_url
}

output "rds_endpoint" {
  description = "RDS address (private; reachable only from inside the VPC)."
  value       = aws_db_instance.main.address
}

output "ecs_cluster" {
  description = "ECS cluster name (for `aws ecs update-service --force-new-deployment`)."
  value       = aws_ecs_cluster.main.name
}

output "ecs_service" {
  description = "ECS service name."
  value       = aws_ecs_service.api.name
}

output "attachments_bucket" {
  description = "S3 bucket holding copa file attachments."
  value       = aws_s3_bucket.attachments.bucket
}
