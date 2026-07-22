# Sentry Autofix — GitHub Actions setup

The w_notes app's Sentry notes let you select an issue and tap **Fix**. That calls
the backend's `POST /sentry/autofix`, which gathers the error's context from
Sentry and fires a GitHub `repository_dispatch` at your target repo. A workflow in
that repo runs the **Claude Code Action**, which fixes the bug on an
`autofixes/issue-*` branch and opens a PR. The app polls `GET /sentry/autofix/status`
and shows the PR link.

```
Sentry note (app) ──Fix──▶ POST /sentry/autofix (w_notes backend)
                                │  gathers issue+event context from Sentry
                                ▼
                     repository_dispatch (event_type: sentry-autofix)
                                │
                                ▼
        .github/workflows/sentry-autofix.yml in the TARGET repo
                                │  Claude Code Action fixes on autofixes/issue-*
                                ▼
                     Pull request → main
                                │  then marks the Sentry issue resolved
                                ▼
```

The workflow in this file opens a PR and stops there — that's the portable
setup, and what a new target repo gets.

**In `rileydrcelik/w_notes` the chain continues automatically.** Two further
workflows take it from PR to production with no human in the loop:

```
        Pull request → main
                │
                ▼
    Tests (backend pytest + vitest + playwright)
                │  all green
                ▼
    autofix-ship.yml ──▶ squash merge ──▶ deploy-backend.yml ──▶ ECS
```

`autofix-ship.yml` merges only when every one of these holds: the Tests run
concluded `success`, the PR carries the **`autofix` label**, the branch is
`autofixes/*`, it targets `main`, it is not a draft, the author is the repo
owner or the bot, it's `MERGEABLE`, and its head SHA is exactly the commit CI
tested. Anything else is left for a human, with a comment on the PR saying why.
It deploys only if the fix touched `backend/**`.

### Why a PAT and a label

PRs are authored with **`AUTOFIX_PAT`**, not `GITHUB_TOKEN`. A PR opened by
`github-actions[bot]` counts as coming from a first-time contributor, so its
`pull_request` workflows sit unrun awaiting approval — and approving one does
*not* emit a second `workflow_run: completed` event, so `autofix-ship` never
sees it. The PR ends up green, unmerged, and invisible: a silent stall.

Loosening the repo's approval setting fixes that too, but this repo is public,
so it would auto-run workflows for every stranger's PR. A poisoned Actions cache
from one of those is later restored by a main-branch run that *does* hold
secrets and *does* deploy. The PAT unblocks only our own automation.

The cost is that autofix PRs now look like the owner's own, so authorship can no
longer identify them. The **`autofix` label** carries that weight instead —
applied by the workflow, required by the ship gate. A draft PR is skipped, which
gives an agent a way to submit a low-confidence attempt for human eyes.

**Escape hatch:** `autofix-ship` also accepts `workflow_dispatch` with a PR
number, for a PR stranded by the gate. It re-vets from scratch and requires
every check on the current head to be green, since there's no triggering run to
compare against.

What this does **not** protect against: a fix that passes CI and starts cleanly
but is wrong. The tests are the only reviewer. If a fix reaches production and
misbehaves, the Sentry issue reopens on regression — that's the backstop, and
it's a detection mechanism, not a prevention one.

To go back to review-before-merge, delete `autofix-ship.yml`; nothing else
depends on it.

### Which repo a fix lands in

A note may carry its own `repo` (`owner/name`); without one the server falls
back to `AUTOFIX_REPO`. That fallback is guarded by **`AUTOFIX_PROJECTS`** — the
Sentry project slugs whose code actually lives in `AUTOFIX_REPO` (several
projects can map to one repo; here `w-notes-fastapi` and `w-notes-rn` both do).

A note watching any other project must name its own repo, or the dispatch is
refused with a message saying which project it came from. Without this, tapping
Fix on an unrelated project's issue silently aims an agent at *this* repo, to
fix a bug that isn't in it — and with full automation on, that PR merges and
deploys unreviewed. Leaving `AUTOFIX_PROJECTS` empty disables the check and
restores the old open fallback.

> **Current target: this repo (`rileydrcelik/w_notes`).** `AUTOFIX_REPO` points at
> w_notes and the live workflow already lives at
> [`.github/workflows/sentry-autofix.yml`](../../../.github/workflows/sentry-autofix.yml).
> The default Sentry note watches `aiko-6q/w-notes-fastapi` (the backend project).
> The steps below are the generic "add autofix to any repo" guide — for a *new*
> target repo, copy [`sentry-autofix.yml`](./sentry-autofix.yml) into it and repeat
> steps 2–4 with that repo's slug.

## One-time setup

### 1. Install the workflow in the target repo
Put [`sentry-autofix.yml`](./sentry-autofix.yml) at `.github/workflows/sentry-autofix.yml`
in the target repo and push it to `main`. (A `repository_dispatch` workflow only
runs once it exists on the default branch.) For w_notes this is **already done** —
the file is committed here.

### 2. Add repo secrets + PR permission (in the target repo)
Settings → Secrets and variables → Actions → **New repository secret**:
- `ANTHROPIC_API_KEY` — an Anthropic API key from https://console.anthropic.com/ (pays for the fix).
- `SENTRY_API_TOKEN` — the same Sentry token the backend uses (`event:write` scope), so the workflow can resolve the issue after the PR opens. Omit it to skip auto-resolve.

Then Settings → Actions → General → **Workflow permissions** → enable **"Allow
GitHub Actions to create and approve pull requests"** — the built-in `GITHUB_TOKEN`
can't open PRs otherwise (you'll see `GitHub Actions is not permitted to create ...`).

### 3. Create the fine-grained PAT the backend uses to dispatch
GitHub → Settings → Developer settings → **Fine-grained personal access tokens** →
Generate new token:
- **Resource owner / repository access:** the target repo (e.g. `rileydrcelik/w_notes`). A single token can list multiple repos, so scope it to every repo you want autofixable.
- **Repository permissions:**
  - Contents: **Read and write** (required to create a `repository_dispatch`)
  - Pull requests: **Read** (so the backend can report PR status)
  - Actions: **Read and write**
- Copy the `github_pat_...` value.

### 4. Wire it into the w_notes backend (Terraform / SSM)
The token and target repo travel to the backend the same way the Sentry token
does. In `terraform/app-secrets.auto.tfvars` (gitignored):

```hcl
autofix_repo = "rileydrcelik/w_notes"
github_token = "github_pat_..."   # from step 3
```

Then apply and redeploy the backend so the ECS task picks up `GITHUB_TOKEN` (SSM
secret) and `AUTOFIX_REPO` (plain env):

```
cd terraform && terraform apply
# then push a new backend image / force a new ECS deployment
```

With both set, `local.autofix_enabled` turns on and the `/sentry/autofix`
endpoints go live. If either is missing they return **503**.

## Local backend testing (no AWS)
Set the same two values in `backend/.env` and run the API locally:

```
GITHUB_TOKEN=github_pat_...
AUTOFIX_REPO=rileydrcelik/w_notes
```

```
curl -X POST http://localhost:8000/sentry/autofix \
  -H "Authorization: Bearer <device-key-or-firebase-token>" \
  -H "Content-Type: application/json" \
  -d '{"issue_id":"<sentry-issue-id>","org":"aiko-6q","project":"w-notes-fastapi"}'
```

Expect `202` with `{ dispatched, short_id, branch }`, and a new run under the
target repo's **Actions** tab. Poll status:

```
curl "http://localhost:8000/sentry/autofix/status?short_id=W-NOTES-FASTAPI-3" \
  -H "Authorization: Bearer <token>"
# → { "state": "none" | "branch_created" | "pr_open" | "pr_merged" | "pr_closed", ... }
```

## Guardrails
- PRs only, always from `autofixes/issue-*` into `main`; the workflow has no merge
  step and `GITHUB_TOKEN` isn't granted merge rights beyond a normal PR.
- `concurrency` cancels a superseded run for the same issue branch, capping token
  spend on double-taps.
- The fix branch name is derived deterministically from the Sentry short id by the
  backend (`_branch_for`) and passed in the dispatch payload, so the app's status
  poll and the workflow always agree on the branch.
