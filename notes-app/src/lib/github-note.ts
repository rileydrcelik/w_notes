/**
 * Helpers for GitHub plugin notes. A GitHub note stores which repo it watches in
 * its opaque `pluginConfig` JSON; this parses it back out safely.
 */
import type { Note } from '@/data/notes';

export type GithubTarget = {
  /** The watched repo as "owner/name". */
  repo: string;
  /** Human-readable repo name for labels; falls back to the slug when absent. */
  repoName?: string;
};

/** One GitHub issue label (name + 6-hex color without the leading '#'). */
export type IssueLabel = { name: string; color?: string | null };

/**
 * A freshly-created issue as returned by `POST /github/issues` and consumed by
 * the issues screen (to prepend to the list) — a subset of the backend's issue
 * shape. Lives here (not in the compose component) so the compose sheet, the
 * issues screen, and the GitHub selection store can all share it without
 * importing each other.
 */
export type CreatedIssue = {
  number: number;
  title: string;
  state?: string | null;
  html_url?: string | null;
  author?: string | null;
  labels: IssueLabel[];
  assignees: string[];
  comments?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  milestone?: string | null;
  body?: string | null;
};

/**
 * The repo a GitHub note points at, or null if it's not a GitHub note or its
 * config is missing/corrupt (so callers can render a "not configured" state
 * rather than crash on bad JSON). `repo` is required; `repoName` is an optional
 * enricher tolerated-missing so older notes still parse.
 */
export function githubTarget(note: Pick<Note, 'pluginType' | 'pluginConfig'>): GithubTarget | null {
  if (note.pluginType !== 'github' || !note.pluginConfig) return null;
  try {
    const parsed = JSON.parse(note.pluginConfig) as Partial<GithubTarget>;
    if (parsed && typeof parsed.repo === 'string') {
      return {
        repo: parsed.repo,
        repoName: typeof parsed.repoName === 'string' ? parsed.repoName : undefined,
      };
    }
  } catch {
    // fall through to null
  }
  return null;
}
