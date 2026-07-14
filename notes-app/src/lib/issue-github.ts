/**
 * Two-way bridge between task-manager issues and real GitHub issues. When an
 * issue lives under a *GitHub-connected* issue type (see {@link IssueTypeConfig})
 * in a project with a `repo`:
 *  - creating it opens a matching GitHub issue (title, description, type + select/
 *    stars attributes as labels, People as assignees) and records its number;
 *  - toggling done closes/reopens it; editing attributes re-pushes labels/assignees;
 *  - back-sync ({@link ../lib/github-backsync}) pulls GitHub changes the other way.
 *
 * The GitHub REST token stays on the server; these just call the `/github/issues`
 * proxy endpoints. Failures surface to the caller (reported to Sentry, shown to
 * the user), never blocking the optimistic local write.
 */
import type { Issue, IssueAttrValue } from '@/data/notes';
import type { AttrDef } from '@/lib/project';
import { ApiError, apiFetch } from '@/lib/sync/api';

/**
 * Separator between an attribute's name and value in a GitHub label, e.g.
 * `Status: In Progress`. This `Name: value` shape is how select/stars attributes
 * round-trip through GitHub labels (People uses assignees instead).
 */
const LABEL_SEP = ': ';

/** The subset of `POST /github/issues` we read back — just the new number. */
type CreatedIssue = { number: number };

/** A GitHub label as returned by the proxy (name + display color). */
export type GithubLabel = { name: string; color?: string };

/** One GitHub issue as returned by `GET /github/issues` (PRs already excluded). */
export type GithubIssue = {
  number: number;
  title: string;
  state?: string | null;
  body?: string | null;
  labels: GithubLabel[];
  assignees: string[];
  updated_at?: string | null;
};

type GithubIssueList = { issues: GithubIssue[]; next_cursor: string | null };

/** True when a GitHub issue in this state should be `done` locally. */
export const githubDone = (state?: string | null): boolean => state === 'closed';

/** The issue body sent to GitHub — just the user's description (attributes live
 *  in labels/assignees, which GitHub renders natively and can round-trip). */
export function githubIssueBody(description: string | undefined): string | undefined {
  const desc = description?.trim();
  return desc || undefined;
}

/**
 * The managed GitHub labels for an issue: the issue type's name, plus one
 * `Name: value` label per set `select`/`stars` attribute. `people` attributes
 * map to assignees ({@link githubIssueAssignees}), not labels. This is the full
 * set this app owns; labels a user added on GitHub are preserved separately via
 * {@link mergeManagedLabels}.
 */
export function githubIssueLabels(
  typeName: string | undefined,
  attributes: AttrDef[],
  values: Record<string, IssueAttrValue>,
): string[] {
  const labels: string[] = [];
  if (typeName?.trim()) labels.push(typeName.trim());
  for (const attr of attributes) {
    const v = values[attr.id];
    if (attr.type === 'select' && typeof v === 'string' && v.trim()) {
      labels.push(`${attr.name}${LABEL_SEP}${v.trim()}`);
    } else if (attr.type === 'stars' && typeof v === 'number' && v > 0) {
      labels.push(`${attr.name}${LABEL_SEP}${v}`);
    }
  }
  return labels;
}

/**
 * The GitHub logins to assign, drawn from every `people` attribute's value (each
 * stores repo assignee logins). GitHub silently ignores logins that aren't
 * actually assignable, so this is safe to send as-is.
 */
export function githubIssueAssignees(
  attributes: AttrDef[],
  values: Record<string, IssueAttrValue>,
): string[] {
  const logins: string[] = [];
  for (const attr of attributes) {
    if (attr.type !== 'people') continue;
    const v = values[attr.id];
    if (Array.isArray(v)) logins.push(...v.filter((x): x is string => typeof x === 'string'));
  }
  return logins.filter((v, i, arr) => arr.indexOf(v) === i);
}

/**
 * Whether `label` is one this app manages for the given project — either it
 * equals an issue-type name, or it has the `Name: value` shape of a known
 * `select`/`stars` attribute. Used to strip stale managed labels on push while
 * leaving foreign labels (added directly on GitHub) untouched.
 */
export function isManagedLabel(label: string, attributes: AttrDef[], typeNames: string[]): boolean {
  const lower = label.toLowerCase();
  if (typeNames.some((t) => t.toLowerCase() === lower)) return true;
  const idx = label.indexOf(LABEL_SEP);
  if (idx <= 0) return false;
  const name = label.slice(0, idx).trim().toLowerCase();
  return attributes.some(
    (a) => (a.type === 'select' || a.type === 'stars') && a.name.toLowerCase() === name,
  );
}

/**
 * Overlay our desired managed labels onto an issue's current GitHub labels,
 * preserving any foreign labels a user added directly on GitHub (so a task-
 * manager attribute edit doesn't wipe them).
 */
export function mergeManagedLabels(
  current: string[],
  managed: string[],
  attributes: AttrDef[],
  typeNames: string[],
): string[] {
  const out = current.filter((l) => !isManagedLabel(l, attributes, typeNames));
  const seen = new Set(out.map((l) => l.toLowerCase()));
  for (const l of managed) {
    if (!seen.has(l.toLowerCase())) {
      out.push(l);
      seen.add(l.toLowerCase());
    }
  }
  return out;
}

/**
 * Derive attribute *values* for a mirrored issue from its GitHub labels +
 * assignees, updating only the project's **built-in** attributes (Status,
 * Priority, People) — GitHub is source-of-truth for those. Custom attributes are
 * left exactly as `existing` has them (they're w-notes-only overlays). A
 * built-in with no corresponding label/assignee is cleared.
 */
export function githubToAttrs(
  attributes: AttrDef[],
  labels: GithubLabel[],
  assignees: string[],
  existing: Record<string, IssueAttrValue>,
): Record<string, IssueAttrValue> {
  const next: Record<string, IssueAttrValue> = { ...existing };
  const names = labels.map((l) => l.name);
  for (const attr of attributes) {
    if (!attr.builtin) continue;
    if (attr.type === 'people') {
      if (assignees.length) next[attr.id] = [...assignees];
      else delete next[attr.id];
      continue;
    }
    const prefix = `${attr.name.toLowerCase()}${LABEL_SEP}`;
    const match = names.find((n) => n.toLowerCase().startsWith(prefix));
    if (!match) {
      delete next[attr.id];
      continue;
    }
    const value = match.slice(match.indexOf(LABEL_SEP) + LABEL_SEP.length).trim();
    if (attr.type === 'select') {
      next[attr.id] = value;
    } else if (attr.type === 'stars') {
      const n = parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) next[attr.id] = Math.min(5, n);
      else delete next[attr.id];
    }
  }
  return next;
}

/** Open a GitHub issue for a connected type; resolves to its issue number. */
export async function createGithubIssue(
  repo: string,
  input: { title: string; body?: string; labels?: string[]; assignees?: string[] },
): Promise<number> {
  const issue = await apiFetch<CreatedIssue>(`/github/issues?repo=${encodeURIComponent(repo)}`, {
    method: 'POST',
    body: {
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      ...(input.labels?.length ? { labels: input.labels } : {}),
      ...(input.assignees?.length ? { assignees: input.assignees } : {}),
    },
  });
  return issue.number;
}

/**
 * Open a GitHub issue mirroring an already-created local issue, resolving to its
 * new number. Used to backfill a type's existing issues when it's newly switched
 * to GitHub-tracked — the same title/body/labels/assignees mapping as a fresh
 * create, just sourced from a stored {@link Issue} rather than a compose form.
 */
export function openGithubIssueForIssue(
  repo: string,
  typeName: string | undefined,
  attributes: AttrDef[],
  issue: Issue,
): Promise<number> {
  return createGithubIssue(repo, {
    title: issue.title,
    body: githubIssueBody(issue.description),
    labels: githubIssueLabels(typeName, attributes, issue.attrs),
    assignees: githubIssueAssignees(attributes, issue.attrs),
  });
}

/** One page of the repo's issues (state=all), for back-sync reconciliation. */
export function listGithubIssues(repo: string, cursor?: string): Promise<GithubIssueList> {
  const params = new URLSearchParams({ repo, state: 'all', limit: '100' });
  if (cursor) params.set('cursor', cursor);
  return apiFetch<GithubIssueList>(`/github/issues?${params.toString()}`);
}

/** The labels currently on a single GitHub issue (for foreign-label-preserving edits). */
export async function getGithubIssueLabels(repo: string, number: number): Promise<string[]> {
  const issue = await apiFetch<{ labels: GithubLabel[] }>(
    `/github/issues/${number}?repo=${encodeURIComponent(repo)}`,
  );
  return (issue.labels ?? []).map((l) => l.name);
}

/**
 * Update a mirrored GitHub issue: any of state (close/reopen), labels, and
 * assignees. Provided fields replace their GitHub value; omitted fields are left
 * untouched (the backend sends only what's present).
 */
export async function updateGithubIssue(
  repo: string,
  number: number,
  fields: {
    state?: 'open' | 'closed';
    stateReason?: string;
    labels?: string[];
    assignees?: string[];
  },
): Promise<void> {
  await apiFetch(`/github/issues/${number}?repo=${encodeURIComponent(repo)}`, {
    method: 'PATCH',
    body: {
      ...(fields.state ? { state: fields.state } : {}),
      ...(fields.stateReason ? { state_reason: fields.stateReason } : {}),
      ...(fields.labels ? { labels: fields.labels } : {}),
      ...(fields.assignees ? { assignees: fields.assignees } : {}),
    },
  });
}

/** Close (done) or reopen (undo) the GitHub issue mirroring a connected issue. */
export function setGithubIssueState(repo: string, number: number, done: boolean): Promise<void> {
  return updateGithubIssue(
    repo,
    number,
    done ? { state: 'closed', stateReason: 'completed' } : { state: 'open' },
  );
}

/**
 * Turn a failed push into a human-readable reason the user can act on. The
 * backend maps GitHub's own auth failures (401/403) to a 502, so that status
 * almost always means the *server's* token can't write issues to this repo —
 * the single most common cause (fine-grained tokens grant repo access and the
 * Issues permission separately). Everything else falls back to the raw message.
 */
export function githubSyncErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.status) {
      case 502:
        return "GitHub rejected the server's token for this repo. A fine-grained token needs Issues → Read and write for it (repo access alone isn't enough); a classic token needs the repo scope. Note the token lives on the server, not in the app.";
      case 503:
        return 'GitHub isn’t configured on the server (no token set). Set github_token in the backend and restart it.';
      case 404:
        return 'Repo not found, or the server token can’t see it. Check owner/name, and that the token has access to it.';
      case 410:
        return 'Issues are disabled on this repo (Settings → General → Features → Issues).';
      case 422:
        return 'GitHub rejected the request (bad repo format or invalid field).';
      default:
        return e.body?.trim() || e.message;
    }
  }
  return e instanceof Error ? e.message : 'Unknown error.';
}
