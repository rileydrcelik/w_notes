/**
 * Helpers for Sentry plugin notes. A Sentry note stores which org/project it
 * watches in its opaque `pluginConfig` JSON; this parses it back out safely.
 */
import type { Note } from '@/data/notes';

export type SentryTarget = {
  org: string;
  project: string;
  /** Human-readable project name for labels; falls back to the slug when absent. */
  projectName?: string;
  /** GitHub "owner/name" autofix PRs target; server default when absent. */
  repo?: string;
};

/**
 * The org/project a Sentry note points at, or null if it's not a Sentry note or
 * its config is missing/corrupt (so callers can render a "not configured" state
 * rather than crash on bad JSON). `org`/`project` are required; `projectName`
 * and `repo` are optional enrichers tolerated-missing so older notes still parse.
 */
export function sentryTarget(note: Pick<Note, 'pluginType' | 'pluginConfig'>): SentryTarget | null {
  if (note.pluginType !== 'sentry' || !note.pluginConfig) return null;
  try {
    const parsed = JSON.parse(note.pluginConfig) as Partial<SentryTarget>;
    if (parsed && typeof parsed.org === 'string' && typeof parsed.project === 'string') {
      return {
        org: parsed.org,
        project: parsed.project,
        projectName: typeof parsed.projectName === 'string' ? parsed.projectName : undefined,
        repo: typeof parsed.repo === 'string' ? parsed.repo : undefined,
      };
    }
  } catch {
    // fall through to null
  }
  return null;
}
