/**
 * Two-way bridge between task-manager issues and real GitHub issues. When an
 * issue lives under a *GitHub-connected* issue type (see {@link IssueTypeConfig})
 * in a project with a `repo`:
 *  - creating it opens a matching GitHub issue (title, description + attributes as
 *    a managed body block, issue types as labels, People as assignees) and records
 *    its number;
 *  - toggling done closes/reopens it; editing attributes re-writes the body block
 *    (and re-pushes type labels / assignees);
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
 * Separator between an attribute's name and value in a *legacy* GitHub label,
 * e.g. `Status: In Progress`. Attributes are no longer written as labels (they
 * live in the body's managed block), but this shape is still recognized so that
 * {@link isManagedLabel} can strip stale attribute labels left by older versions
 * on the next edit.
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

/**
 * Delimiters bounding the app-managed *attributes* block inside a GitHub issue
 * body. w-notes owns everything between them and rewrites it on every push; text
 * outside the markers is the user's own description and is preserved untouched.
 * Issue types map to GitHub labels and `people` to assignees; every other set
 * attribute (built-in Status/Priority + custom selects) is rendered here so it
 * shows as readable content instead of cluttering the issue's labels.
 */
const ATTR_BLOCK_START = '<!-- w-notes:attributes -->';
const ATTR_BLOCK_END = '<!-- /w-notes:attributes -->';

/** Sentinel standing in for an escaped table pipe while splitting a row (keeps
 *  the parser off regex lookbehind, which isn't guaranteed on all JS engines). */
const PIPE_HOLD = '\u0000';

/** Escape a value so a literal '|' or newline can't break the markdown table. */
function escapeCell(v: string): string {
  return v.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Render the managed attributes table for an issue: one row per set `select`
 * (its value) or `stars` (as filled stars) attribute, built-in or custom.
 * `people` is omitted — it maps to GitHub assignees. Returns '' when nothing is
 * set, so no empty block is written.
 */
function renderAttrsBlock(attributes: AttrDef[], values: Record<string, IssueAttrValue>): string {
  const rows: string[] = [];
  for (const attr of attributes) {
    const v = values[attr.id];
    if (attr.type === 'select' && typeof v === 'string' && v.trim()) {
      rows.push(`| ${escapeCell(attr.name)} | ${escapeCell(v.trim())} |`);
    } else if (attr.type === 'stars' && typeof v === 'number' && v > 0) {
      rows.push(`| ${escapeCell(attr.name)} | ${'★'.repeat(Math.min(5, v))} |`);
    }
  }
  if (rows.length === 0) return '';
  return [ATTR_BLOCK_START, '| Attribute | Value |', '| --- | --- |', ...rows, ATTR_BLOCK_END].join('\n');
}

/** Strip the managed attributes block from a body, leaving the user's description. */
function stripAttrsBlock(body: string): string {
  const start = body.indexOf(ATTR_BLOCK_START);
  if (start === -1) return body.trim();
  const endMarker = body.indexOf(ATTR_BLOCK_END, start);
  const end = endMarker === -1 ? body.length : endMarker + ATTR_BLOCK_END.length;
  return (body.slice(0, start) + body.slice(end)).trim();
}

/**
 * Replace (or insert) the managed attributes block in an existing GitHub issue
 * body, preserving the user's description above it. Used when an attribute edit
 * is pushed to an already-open issue.
 */
export function upsertAttrsBlock(
  body: string | null | undefined,
  attributes: AttrDef[],
  values: Record<string, IssueAttrValue>,
): string {
  const desc = stripAttrsBlock(body ?? '');
  const block = renderAttrsBlock(attributes, values);
  if (!block) return desc;
  return desc ? `${desc}\n\n${block}` : block;
}

/** Parse the managed attributes block back into a name→value map (lowercased
 *  keys). Null when the block is absent — so a pull can tell "no managed data"
 *  apart from "block present but this attribute cleared". */
function parseAttrsBlock(body: string | null | undefined): Map<string, string> | null {
  if (!body) return null;
  const start = body.indexOf(ATTR_BLOCK_START);
  if (start === -1) return null;
  const endMarker = body.indexOf(ATTR_BLOCK_END, start);
  const inner = body.slice(start + ATTR_BLOCK_START.length, endMarker === -1 ? undefined : endMarker);
  const map = new Map<string, string>();
  for (const line of inner.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .replace(/\\\|/g, PIPE_HOLD)
      .split('|')
      .slice(1, -1)
      .map((c) => c.split(PIPE_HOLD).join('|').trim());
    if (cells.length < 2) continue;
    const name = cells[0].toLowerCase();
    // Skip the header row and the |---|---| separator.
    if (name === 'attribute' || /^-+$/.test(cells[0].replace(/\s/g, ''))) continue;
    map.set(name, cells[1]);
  }
  return map;
}

/**
 * The issue body sent to GitHub on create: the user's description followed by the
 * managed attributes block (when any attribute is set). Attributes render as a
 * table here rather than as labels, so GitHub shows them as readable content and
 * the issue's labels stay to types only. Returns undefined when empty.
 */
export function githubIssueBody(
  description: string | undefined,
  attributes?: AttrDef[],
  values?: Record<string, IssueAttrValue>,
): string | undefined {
  const desc = description?.trim() ?? '';
  const block = attributes && values ? renderAttrsBlock(attributes, values) : '';
  const combined = block ? (desc ? `${desc}\n\n${block}` : block) : desc;
  return combined || undefined;
}

/** The user-facing description of a GitHub issue body — the managed attributes
 *  block removed. Used when importing an unmirrored issue so the block markup
 *  doesn't leak into the local description. */
export function githubIssueDescription(body: string | null | undefined): string | undefined {
  const desc = stripAttrsBlock(body ?? '');
  return desc || undefined;
}

/**
 * The managed GitHub labels for an issue: one label per issue type it belongs to
 * (an issue can have several). Attribute values are NOT labels — they live in the
 * issue body's managed block ({@link githubIssueBody}); `people` maps to
 * assignees ({@link githubIssueAssignees}). Labels a user added on GitHub are
 * preserved separately via {@link mergeManagedLabels}. `typeNames` accepts a
 * single name or a list.
 */
export function githubIssueLabels(typeNames: string | string[] | undefined): string[] {
  const labels: string[] = [];
  const names = typeNames == null ? [] : Array.isArray(typeNames) ? typeNames : [typeNames];
  for (const name of names) {
    const trimmed = name?.trim();
    // De-dupe (case-insensitively) so two types with the same name don't double up.
    if (trimmed && !labels.some((l) => l.toLowerCase() === trimmed.toLowerCase())) {
      labels.push(trimmed);
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
 * equals an issue-type name, or it has the legacy `Name: value` shape of a known
 * `select`/`stars` attribute. Used to strip managed labels on push while leaving
 * foreign labels (added directly on GitHub) untouched; the attribute-shape check
 * also cleans up stale attribute labels written by versions that used labels for
 * attributes (they're never re-added, since attributes now live in the body).
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
 * Derive attribute *values* for a mirrored issue from GitHub, updating only the
 * project's **built-in** attributes (Status, Priority, People) — GitHub is
 * source-of-truth for those. Status/Priority come from the managed attributes
 * block in the issue `body`; People from `assignees`. Custom attributes are left
 * exactly as `existing` has them (they're w-notes-only overlays). When the body
 * carries a managed block, a built-in with no matching row is cleared; when the
 * block is absent entirely, built-ins are left untouched (so a pull can't wipe
 * them, e.g. if a user deleted the block on GitHub).
 */
export function githubToAttrs(
  attributes: AttrDef[],
  body: string | null | undefined,
  assignees: string[],
  existing: Record<string, IssueAttrValue>,
): Record<string, IssueAttrValue> {
  const next: Record<string, IssueAttrValue> = { ...existing };
  const parsed = parseAttrsBlock(body);
  for (const attr of attributes) {
    if (!attr.builtin) continue;
    if (attr.type === 'people') {
      if (assignees.length) next[attr.id] = [...assignees];
      else delete next[attr.id];
      continue;
    }
    // No managed block → leave built-in select/stars untouched.
    if (!parsed) continue;
    const raw = parsed.get(attr.name.toLowerCase());
    if (raw == null || raw === '') {
      delete next[attr.id];
      continue;
    }
    if (attr.type === 'select') {
      next[attr.id] = raw;
    } else if (attr.type === 'stars') {
      // Stars render as filled '★'; fall back to a bare number if a user typed one.
      const stars = (raw.match(/★/g) ?? []).length;
      const n = stars > 0 ? stars : parseInt(raw, 10);
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
    body: githubIssueBody(issue.description, attributes, issue.attrs),
    labels: githubIssueLabels(typeName),
    assignees: githubIssueAssignees(attributes, issue.attrs),
  });
}

/** One page of the repo's issues (state=all), for back-sync reconciliation. */
export function listGithubIssues(repo: string, cursor?: string): Promise<GithubIssueList> {
  const params = new URLSearchParams({ repo, state: 'all', limit: '100' });
  if (cursor) params.set('cursor', cursor);
  return apiFetch<GithubIssueList>(`/github/issues?${params.toString()}`);
}

/** The current labels + body of a single GitHub issue — enough to push an edit
 *  that preserves foreign labels and the user's description while rewriting the
 *  managed type labels / attributes block. */
export async function getGithubIssueDetail(
  repo: string,
  number: number,
): Promise<{ labels: string[]; body: string | null }> {
  const issue = await apiFetch<{ labels: GithubLabel[]; body?: string | null }>(
    `/github/issues/${number}?repo=${encodeURIComponent(repo)}`,
  );
  return { labels: (issue.labels ?? []).map((l) => l.name), body: issue.body ?? null };
}

/**
 * Update a mirrored GitHub issue: any of state (close/reopen), title, body,
 * labels, and assignees. Provided fields replace their GitHub value; omitted
 * fields are left untouched (the backend sends only what's present).
 */
export async function updateGithubIssue(
  repo: string,
  number: number,
  fields: {
    state?: 'open' | 'closed';
    stateReason?: string;
    title?: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  },
): Promise<void> {
  await apiFetch(`/github/issues/${number}?repo=${encodeURIComponent(repo)}`, {
    method: 'PATCH',
    body: {
      ...(fields.state ? { state: fields.state } : {}),
      ...(fields.stateReason ? { state_reason: fields.stateReason } : {}),
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.body !== undefined ? { body: fields.body } : {}),
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
