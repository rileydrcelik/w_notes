/**
 * Helpers for task-manager "project" folders. A project folder stores its repo
 * and shared attribute schema in the folder's opaque `config` JSON; this parses
 * it back out safely and defines the default schema new projects start from.
 *
 * Structure: a `kind='project'` folder holds issue-type notes
 * (`plugin_type='issuetype'`), and each issue (a row in the `issues` table) is
 * filed under one type-note. Attribute *definitions* live here on the project
 * (shared across every type); attribute *values* live on each issue's `attrs`,
 * keyed by these definitions' ids.
 */
import type { Folder } from '@/data/notes';

/**
 * An attribute's editor type:
 * - `select`  — one of `options` (e.g. Status).
 * - `stars`   — a 1–5 star rating (e.g. Priority).
 * - `people`  — GitHub assignees (logins), pulled from the project's repo.
 */
export type AttrType = 'select' | 'stars' | 'people';

export type AttrDef = {
  /** Stable id used as the key into an issue's `attrs`. */
  id: string;
  name: string;
  type: AttrType;
  /** Choices for a `select` attribute; unused for stars/people. */
  options?: string[];
  /** True for the seeded defaults (still removable, just not user-authored). */
  builtin?: boolean;
};

export type ProjectConfig = {
  /** The GitHub repo (owner/name) this project's connected types use. */
  repo?: string;
  /** The shared attribute schema every issue type in the project uses. */
  attributes: AttrDef[];
};

/** The plugin marker on a note that makes it an issue *type* within a project. */
export const ISSUE_TYPE_PLUGIN = 'issuetype';

/** Config carried by an issue-type note (`plugin_config`). */
export type IssueTypeConfig = {
  /** When true, issues of this type mirror GitHub issues in the project's repo. */
  githubConnected: boolean;
  /** Sort order among the project's types. */
  order: number;
  color?: string;
};

/** The default attribute schema a new project starts with (all removable). */
export function defaultAttributes(): AttrDef[] {
  return [
    { id: 'status', name: 'Status', type: 'select', options: ['Todo', 'In Progress', 'Done'], builtin: true },
    { id: 'people', name: 'People', type: 'people', builtin: true },
    { id: 'priority', name: 'Priority', type: 'stars', builtin: true },
  ];
}

/** A fresh project config (optionally pre-filled with a repo). */
export function emptyProjectConfig(repo?: string): ProjectConfig {
  return { repo: repo || undefined, attributes: defaultAttributes() };
}

/**
 * The parsed config of a project folder, or null when it's not a project folder
 * or its config is missing/corrupt (so callers can render a "not configured"
 * setup state rather than crash on bad JSON).
 */
export function projectConfig(folder: Pick<Folder, 'kind' | 'config'>): ProjectConfig | null {
  if (folder.kind !== 'project' || !folder.config) return null;
  try {
    const parsed = JSON.parse(folder.config) as Partial<ProjectConfig>;
    if (parsed && Array.isArray(parsed.attributes)) {
      return {
        repo: typeof parsed.repo === 'string' ? parsed.repo : undefined,
        attributes: parsed.attributes.filter(isAttrDef),
      };
    }
  } catch {
    // fall through to null
  }
  return null;
}

/** Serialize a project config for storage in the folder's `config` column. */
export function serializeProjectConfig(config: ProjectConfig): string {
  return JSON.stringify(config);
}

/** A short, reasonably-unique id for a new custom attribute. */
export function newAttrId(): string {
  return `attr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Parse an issue-type note's `plugin_config`, filling safe defaults on bad/absent JSON. */
export function parseTypeConfig(pluginConfig?: string): IssueTypeConfig {
  if (pluginConfig) {
    try {
      const cfg = JSON.parse(pluginConfig) as Partial<IssueTypeConfig>;
      return {
        githubConnected: !!cfg.githubConnected,
        order: typeof cfg.order === 'number' ? cfg.order : 0,
        color: typeof cfg.color === 'string' ? cfg.color : undefined,
      };
    } catch {
      // fall through to defaults
    }
  }
  return { githubConnected: false, order: 0 };
}

/** Serialize an issue-type note's config for the note's `plugin_config` column. */
export function serializeTypeConfig(cfg: IssueTypeConfig): string {
  return JSON.stringify(cfg);
}

function isAttrDef(value: unknown): value is AttrDef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    (v.type === 'select' || v.type === 'stars' || v.type === 'people')
  );
}
