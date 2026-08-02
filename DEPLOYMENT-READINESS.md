# Prep for wider distribution — findings + plan

Written 2026-08-02 against `worktree-features` (= `origin/main` + the four
commits from this session).

## The headline, stated plainly

You asked about account syncing, and there are real sync defects below (§B).
But they are not what blocks distribution. **The blocker is authorization.**

The API authenticates every caller and authorizes almost none of them. Today
that is invisible because there is effectively one user. The moment there is a
second, the plugin routes are shared credentials with no owner check.

This is not a new subsystem to invent — the codebase already solved it once, for
publishing, and wrote down exactly this reasoning in `config.py:103`:

> Comma-separated account emails allowed to publish. **This is a multi-tenant
> API: without an allowlist, *any* account could push posts onto the site
> owner's portfolio** just by flipping a note's `published` flag. Empty =>
> nobody can publish (fail closed).

That paragraph is correct, and it applies word-for-word to the GitHub, Sentry,
autofix, resume and LaTeX routes — which are strictly more powerful than
publishing. The allowlist was applied to exactly one of them.

---

## §A — Authorization (blocks distribution)

### A0. "Authenticated" currently means "sent any string"

`deps.py:131 get_current_user` verifies a Firebase JWT *if the token looks like
one*. Otherwise it falls through to `_user_by_device_key(session, token)`, which
is `_get_or_create_user(...)` — it **lazily creates an account from an arbitrary
bearer string**. That is intended for the anonymous pre-login identity, and for
sync it is fine: a device key scopes you to your own rows and nothing else.

It is not fine for the plugin routes, because those ignore the user entirely.

```
Authorization: Bearer literally-anything   →  a valid account
```

Every finding below inherits this. Severity is "anyone on the internet", not
"any registered user".

### A1. GitHub routes act as you, for everyone — **critical**

`routers/github_issues.py`. Every route takes `user: User = Depends(get_current_user)`
and then never reads `user`. Authorization is `_require_token()`, which returns
the single server-wide `settings.github_token`.

- `GET /github/repos` — the docstring is candid: *"Every repo the server token
  can see."* That is your private repo list, served to any caller.
- `POST /github/issues`, `PATCH /github/issues/{number}` — file and close issues
  in those repos.
- `/labels`, `/assignees`, `/milestones`, `/issues/{n}/comments` — same.

The note's `pluginConfig` carries the repo, and it is client-supplied, so the
caller chooses the target repo per request.

### A2. Autofix accepts an unvalidated repo override — **critical**

`routers/sentry.py:551 _resolve_repo`:

```python
if override:
    if not _REPO_RE.match(override):      # format only
        raise HTTPException(422, "Invalid repo (expected owner/name)")
    return override                        # ← no ownership check
```

The `_autofix_projects()` guard below it is careful and well-reasoned, but it
gates only the **fallback** path. An explicit override returns early and skips
it. So any caller can aim a dispatch at any `owner/name`.

GitHub will reject repos the server token can't reach, which bounds the blast
radius to your own repos — but that is the valuable set. Per the
`autofix-ship-pipeline` memory, autofix runs Claude at ~$0.40/run and, on
success, **merges and deploys to prod unattended**. An untrusted caller should
not be able to start that.

`AUTOFIX_SHIP_DRY_RUN` disarms the merge step and is the fastest mitigation
while A1/A2 are fixed properly.

### A3. Metered and CPU-heavy routes are open — **high**

- `routers/resume.py` — `/resume/entry`, `/edit`, `/harden`, `/tailor`,
  `/job-posting` all spend **your** `anthropic_api_key`. Unmetered, unbilled to
  the caller, no per-user cap.
- `routers/latex.py:341` — `_user: User = Depends(get_current_user)`. The
  underscore says it: bound and deliberately unused. `latexmk` on a 1.34GB TeX
  Live image is heavy CPU, and it runs on a **single uvicorn worker**
  (`Dockerfile:102`, no `--workers`). A handful of concurrent compiles is a
  denial of service against the whole API, `/health` included.

### A4. No rate limiting anywhere — **high**

No `slowapi`, no middleware, nothing in `main.py`. Combined with A0, every
endpoint is an open faucet.

---

## §B — Sync correctness for special notes (your actual question)

Good news first, because it narrows the search: **table coverage is complete and
correct.** All six synced tables (`folders`, `notes`, `copa_items`, `issues`,
`finance_sheets`, `resume_versions`) are present on both sides — client
`getDirty`/`applyServerRows` and server `_upsert_batch`/`changed`. The only
local table that doesn't sync is `settings`, which is deliberate (cursor, device
key, `synced_uid` — facts about a device).

Cross-version safety is also handled properly: `_PRESERVE_IF_NULL` COALESCEs
`plugin_type`, `plugin_config`, `published`, `type_ids`, `kind`, `config` and
the copa file columns, so an older client's NULL can't wipe a value it doesn't
know about. I checked the one that looked suspicious — `gh_number` is *not* in
that list — and it is fine: `gh_number` shipped in the original `0005` issues
migration, so no client predates it.

### B1. Deleting a special note orphans its rows, permanently — **high**

`db.ts:707 deleteNote` soft-deletes the note row and nothing else:

```sql
UPDATE notes SET deleted_at = ?, updated_at = ?, dirty = 1 ... WHERE id = ?
```

There is no cascade to the child tables, and there are **no foreign keys** in
the local schema to supply one (no `FOREIGN KEY`, no `PRAGMA foreign_keys`).
So deleting:

- a **finance** note leaves its `finance_sheets` row
- a **resume** note leaves every `resume_versions` row (each a full LaTeX doc)
- an **issuetype** note leaves every `issues` row filed under it

Those orphans are never deleted, so they sync forever, on every device, and
count toward every pull. Two consequences:

1. **They feed the 504.** Resume versions and finance sheets are the largest
   rows in the schema. This is the exact payload the paging fix was written to
   survive, and it grows monotonically with every deleted plugin note.
2. **Restore-from-trash accidentally works**, which is why nobody noticed. The
   orphan is only visible as unbounded growth.

Note the server does *not* cascade either — `Issue` has `ForeignKey("users.id")`
for the account, not for `note_id`. So this must be fixed client-side, in
`deleteNote`, marking the children deleted+dirty in the same transaction.

### B2. Issues can outlive their type across a page boundary — **low, benign**

Worth recording because the paging change I committed this session introduces
it. `applyServerRows` inserts folders → notes → copa → issues → sheets →
versions within one page, but a note edited recently carries a *higher*
`server_seq` than an issue created long ago, so on a first sync the issue can
land in an earlier page than its parent note.

With no local FKs the insert simply succeeds and the row is invisible until the
note arrives on a later page. Self-correcting, no crash, no loss. **No action
needed** — but do not add FK enforcement to the local schema without also making
`applyServerRows` order-independent, or this becomes a hard failure.

### B3. GitHub-connected issues are the one place two writers disagree

`issues` sync is plain LWW on `updated_at`, and GitHub is a second writer via
back-sync. LWW between two independent writers silently drops one side's edit.
This is a design limit rather than a defect, and it is probably acceptable — but
it should be a deliberate decision before more people use it, not a discovery.

---

## §C — Deploy sequencing (mechanical, but order matters)

1. **Backend before client, always.** Pydantic drops undeclared fields, so a new
   client pushing a field an old backend doesn't model gets a `200`, clears its
   dirty flag, and the data is silently gone. Old client + new backend is safe.
2. Of this session's four commits, `f19ed00` (paging) and `8992311` (autofix)
   touch `backend/**`; push to `main` auto-deploys them via OIDC with no
   approval gate.
3. `alembic heads` is a **single head** (`0008_resume_versions`) — I checked,
   because two files share an `0008` prefix. The chain is linear
   (`0007 → 0008_finance_sheets → 0008_resume_versions`); only the naming is
   confusing. The container runs `alembic upgrade head` on boot, so a second
   head would be a hard boot failure. Re-check this after merging the
   `feat/mocha-theme-account-sync` branch, which adds `0009_user_settings`.
4. The Sentry fingerprint change (`c13833a`) splits `W-NOTES-RN-C` into separate
   issues going forward. Intended — but it changes what you see in your own
   Sentry.

---

## §D — Ops posture

- **Single uvicorn worker.** One slow request blocks every other, including
  `/health`. `--workers` (or more tasks behind the tunnel) is the cheapest win,
  and it is what makes A3 survivable.
- **Default connection pool.** `db.py:15` passes only `pool_pre_ping=True`, so
  5 + 10 overflow. This repo has a history here (PR #2, QueuePool exhaustion),
  and it is the named next suspect if the 504 outlives the paging fix.

---

## Plan

Staged so each step is shippable on its own. Steps 1–2 are what "ready for
wider distribution" actually means; 3–4 are the sync work you asked about.

### Step 1 — Close the open routes (do first, ship alone)

Nothing else matters until this is done.

1. Add `plugin_users` (or reuse `publisher_emails`' shape) — a fail-closed
   email allowlist, matched on `users.email` exactly as publishing does. An
   anonymous device-key account has no email and is therefore refused by
   construction, which is the correct default.
2. Apply it to `/github/*`, `/sentry/*` (autofix especially), `/resume/*` and
   `/latex/compile`. One shared dependency, e.g. `Depends(require_plugin_user)`,
   replacing the currently-ignored `user` binding.
3. Fix `_resolve_repo`: validate an override against the same allowlist the
   fallback uses, instead of returning early on a format match.
4. Set `AUTOFIX_SHIP_DRY_RUN` **now**, before any of this ships, as a stopgap.

Sync itself (`/sync/push`, `/sync/pull`) needs no allowlist — it is already
scoped per user and anonymous use is a real feature.

### Step 2 — Make abuse bounded

5. Rate-limit per user id: tight on `/resume/*`, `/latex/compile` and autofix
   dispatch; loose on sync.
6. Run more than one uvicorn worker.
7. Set explicit `pool_size` / `max_overflow` / `pool_timeout`.

### Step 3 — Fix the orphan cascade (B1)

8. `deleteNote` marks children deleted + dirty in the same transaction, keyed by
   `pluginType`.
9. A one-off cleanup for orphans already in accounts — find `issues` /
   `finance_sheets` / `resume_versions` whose note is deleted or absent, and
   tombstone them.
10. Test: create each plugin-note kind, delete it, assert children are tombstoned
    and the tombstone survives a sync round trip. Mutation-check it.

### Step 4 — Decide B3 deliberately

11. Either accept LWW for GitHub-connected issues and document it, or make
    back-sync merge per-field. Write down which, and why.

### Step 5 — Then ship

12. Backend first, confirm `/health` and one real sync round trip.
13. Web export (grep `dist` for `localhost:8000` — must be 0), then `eas update`.

---

## What I verified vs. inferred

**Read directly in the code:** every §A finding, the §B table-coverage and
`_PRESERVE_IF_NULL` audit, `gh_number` in migration `0005`, the absence of
cascade in `deleteNote`, the absence of local FKs, single worker, default pool,
single alembic head.

**Not verified — I could not observe prod:** whether `github_token` /
`anthropic_api_key` are actually populated in prod SSM (if a key is unset the
matching route 503s and that finding is latent rather than live), and whether
any account other than yours exists today. Both change the *urgency* of §A, not
its correctness. RDS is private; see the `inspect-rds` memory for the CloudShell
route if you want to confirm.
