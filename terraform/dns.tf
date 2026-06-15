# The public DNS record: api.<domain> -> the Cloudflare Tunnel.
#
# CNAME to the tunnel's <id>.cfargotunnel.com edge hostname, proxied (orange
# cloud) so Cloudflare terminates TLS and routes the request down the tunnel to
# the app container. Proxying is mandatory here — the cfargotunnel.com target is
# only reachable through Cloudflare's edge.

resource "cloudflare_record" "api" {
  zone_id = var.cloudflare_zone_id
  name    = var.api_subdomain
  value   = cloudflare_zero_trust_tunnel_cloudflared.api.cname
  type    = "CNAME"
  proxied = true
  ttl     = 1 # ttl must be 1 (automatic) when proxied
}
