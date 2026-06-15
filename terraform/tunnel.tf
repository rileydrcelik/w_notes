# Cloudflare Tunnel — the public ingress, replacing the ALB.
#
# A `cloudflared` sidecar in the ECS task (see ecs.tf) dials *out* to Cloudflare's
# edge and registers this tunnel. Cloudflare terminates TLS at its edge and proxies
# api.<domain> down the tunnel to the app container on localhost:8000. There's no
# load balancer, no ACM cert, no public listener, and no inbound security-group
# rule — the task is unreachable from the internet except through the tunnel.
#
# Requires an *account-scoped* Cloudflare token (Account > Cloudflare Tunnel:Edit,
# plus the existing Zone:DNS:Edit) and var.cloudflare_account_id.

# 32+ random bytes, base64-encoded, used as the tunnel's shared secret.
resource "random_id" "tunnel_secret" {
  byte_length = 35
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "api" {
  account_id = var.cloudflare_account_id
  name       = "${local.name}-api"
  secret     = random_id.tunnel_secret.b64_std

  # "cloudflare" => ingress is managed remotely (by the _config resource below),
  # so cloudflared runs token-only with no local config file.
  config_src = "cloudflare"
}

# Ingress rules: route the API hostname to the local app container; everything
# else gets a 404 (the required catch-all rule).
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "api" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.api.id

  config {
    ingress_rule {
      hostname = local.api_fqdn
      service  = "http://localhost:8000"
    }
    ingress_rule {
      service = "http_status:404"
    }
  }
}
