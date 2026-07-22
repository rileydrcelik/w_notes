# w_notes infrastructure (Terraform)

Deploys the sync backend to AWS: **ECS Fargate** (on Spot) fronted by a
**Cloudflare Tunnel** for HTTPS ingress (no load balancer), with **RDS
PostgreSQL**, secrets in **SSM Parameter Store**, and DNS wired through
**Cloudflare**.

```
Cloudflare edge (api.<domain>, TLS)
        │  (tunnel — task dials OUT, no inbound)
        ▼
ECS Fargate task (public subnet, no inbound SG)
├─ cloudflared sidecar ──connects the tunnel──> Cloudflare
├─ FastAPI container (from ECR) on :8000
├──> RDS Postgres (private)
└──> internet gateway (free egress: Firebase, Sentry)
```

Ingress costs nothing: Cloudflare terminates TLS and the task reaches the edge
over an outbound connection, so there's no ALB, no ACM cert, and no public IPv4
on a load balancer.

## What's a Terraform file again?

Each `.tf` file *declares resources you want to exist*. Terraform diffs that
against reality (`plan`) and makes it so (`apply`). Files in this directory are
read together as one stack — splitting by concern is just for readability:

| File | What it defines |
|------|-----------------|
| `versions.tf` | Terraform/provider versions + the S3 state backend |
| `providers.tf` | AWS + Cloudflare provider setup |
| `variables.tf` | The knobs (see `terraform.tfvars.example`) |
| `locals.tf` | Derived values (FQDN, feature flags) |
| `network.tf` | VPC, subnets, routing (no NAT) |
| `security.tf` | Security groups (the firewalls) |
| `ecr.tf` | Container image registry |
| `secrets.tf` | DB password + SSM Parameter Store entries |
| `iam.tf` | ECS task roles |
| `rds.tf` | PostgreSQL database |
| `tunnel.tf` | Cloudflare Tunnel + ingress rules |
| `dns.tf` | `api.<domain>` → tunnel CNAME (proxied) |
| `ecs.tf` | Cluster, task def (app + cloudflared), service (Spot) |
| `outputs.tf` | Useful values printed after apply |

## Prerequisites

1. **AWS credentials** on your machine (`aws configure` or env vars), with rights
   to create the above.
2. **Terraform ≥ 1.10** installed.
3. **A Cloudflare API token** with two permissions: **Zone → DNS → Edit** for your
   domain *and* **Account → Cloudflare Tunnel → Edit** (Cloudflare dashboard → My
   Profile → API Tokens → Create Token → Custom token). Grab your **Zone ID** and
   **Account ID** from the domain's Overview page (right sidebar).
4. Docker, to build + push the image.

## One-time setup

### 1. Create the state bucket (bootstrap)

```powershell
cd terraform/bootstrap
terraform init
terraform apply -var "state_bucket_name=wnotes-tfstate-<unique-suffix>"
```

Copy that bucket name into `backend.hcl` (from `backend.hcl.example`).

### 2. Configure the main stack

```powershell
cd terraform
Copy-Item terraform.tfvars.example terraform.tfvars   # then edit it
Copy-Item backend.hcl.example backend.hcl             # set the bucket name
$env:TF_VAR_cloudflare_api_token = "<your-token>"

terraform init -backend-config=backend.hcl
```

### 3. Plan and apply

```powershell
terraform plan      # read this — it lists everything that will be created
terraform apply
```

> First apply takes a while (RDS ~5–10 min). The ECS service will keep restarting
> until you push an image — that's expected; do the next step.

### 4. Build + push the image, then deploy

```powershell
$REPO = terraform output -raw ecr_repository_url
$REGION = "us-east-1"

# Log Docker in to ECR
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin ($REPO -replace '/.*$','')

# Build + push (run from repo root so the backend/ build context is correct)
docker build -t "${REPO}:latest" ..\backend
docker push "${REPO}:latest"

# Roll the service onto the new image
aws ecs update-service --cluster (terraform output -raw ecs_cluster) `
  --service (terraform output -raw ecs_service) --force-new-deployment --region $REGION
```

### 5. Point the app at it

```powershell
terraform output api_url     # e.g. https://api.example.com
```

Set that as `EXPO_PUBLIC_API_URL` in `notes-app/.env`, rebuild the app, done.

## Redeploying later

**Normally you don't.** Any push to `main` touching `backend/**` triggers the
`Deploy backend` workflow, which builds the image, tags it with the commit SHA,
registers a task definition revision for it, rolls the service, and verifies
`/health`. Trigger it by hand from the Actions tab after an infra change.

The manual recipe still works if CI is down — but tag the SHA, not just
`:latest`, or you leave ECS with nothing to roll back to.

Infra change → edit the `.tf` files → `terraform plan` → `terraform apply` →
**then deploy**. The service ignores Terraform's `task_definition` (CI owns
which revision runs), so `apply` writes a new revision but does not put it in
front of traffic. The next deploy picks it up, because the workflow builds from
the family's latest revision.

### 6. Enable CI deploys (OIDC)

```powershell
# in terraform.tfvars
github_deploy_repo = "rileydrcelik/w_notes"
```

```powershell
terraform apply
terraform output github_deploy_role_arn
gh secret set AWS_DEPLOY_ROLE --body "<that arn>"
```

No AWS keys live in GitHub: the role trusts GitHub's OIDC issuer, and only for
workflows running on `refs/heads/main` in that one repo. It can push to this
ECR repo, register a revision of this task family, and update this service —
nothing else. If the AWS account already has a GitHub OIDC provider, `apply`
fails with `EntityAlreadyExists`; import it (command is in `github_oidc.tf`).

### Rolling back

Every deploy leaves an immutable `:<sha>` image and its own task definition
revision, so rollback is picking an older revision:

```powershell
aws ecs update-service --cluster wnotes-cluster --service wnotes-api `
  --task-definition wnotes-api:<previous-revision> --region us-east-1
```

A deploy that never stabilises rolls itself back — the service has
`deployment_circuit_breaker { rollback = true }`. A deploy that starts cleanly
and behaves *wrongly* does not; that one is on you to catch.

## Notes & next steps

- **Migrations run on container boot** (`alembic upgrade head`). Safe at
  `desired_count = 1`. Before scaling past one task, move migrations into a
  one-off ECS task so two starting tasks can't race. (Ask me to wire this up.)
- **Ingress is the Cloudflare Tunnel** (`tunnel.tf`). The `api.<domain>` record is
  proxied; Cloudflare terminates TLS at its edge. Watch the tunnel come up in
  Cloudflare → Zero Trust → Networks → Tunnels (or the `cloudflared` log stream).
- **Fargate Spot:** the service runs on Spot to save ~70% on compute. A reclaimed
  task is replaced automatically; at `desired_count = 1` expect rare brief
  downtime. For zero-downtime, add `FARGATE` weight to the service strategy.
- **Prod hardening when you're ready:** RDS `multi_az = true`,
  `deletion_protection = true`, `skip_final_snapshot = false`; ≥2 tasks.
- **Cost (~$26/mo idle):** RDS db.t4g.micro ~$14, Fargate Spot ~$3, task public
  IPv4 ~$3.65, plus minor logs/ECR. No NAT, no ALB, SSM params are free.
- **Teardown:** `terraform destroy` (main stack), then the bootstrap stack. Empty
  the ECR repo + S3 state bucket first if either complains.
```
