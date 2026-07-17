/**
 * Back-sync: pull a project's GitHub issues and reconcile them into the local
 * task manager. Runs on project-feed focus and manual pull-to-refresh (polled,
 * not webhooks). Reconciliation is keyed by `gh_number`:
 *
 *  - **Matched** local issue → its mirrored fields follow GitHub (done from
 *    open/closed, title, and the built-in Status/Priority/People attributes via
 *    {@link githubToAttrs} — Status/Priority read from the managed block in the
 *    issue body, People from assignees). Its *type* (which note it's filed under)
 *    and *custom* attributes are w-notes-only overlays and are never touched by a
 *    pull.
 *  - **Unmatched** GitHub issue → imported into the project's "Unorganized" type
 *    (auto-created on first need), so the user can re-file and enrich it.
 *
 * All writes go through the normal issues store, so imports/updates sync to the
 * user's other devices too. GitHub is source-of-truth for the mirrored fields,
 * which sidesteps the fact that local `updatedAt` is only date-granular.
 */
import type { Issue, IssueAttrValue } from '@/data/notes';
import {
  githubDone,
  githubIssueDescription,
  githubToAttrs,
  listGithubIssues,
} from '@/lib/issue-github';
import type { AttrDef } from '@/lib/project';

/** Store actions the reconciler drives (kept minimal so it stays testable). */
export type BacksyncActions = {
  createIssue: (input: {
    noteId: string;
    title: string;
    description?: string;
    attrs?: Record<string, IssueAttrValue>;
    ghNumber?: number;
  }) => string;
  updateIssue: (
    id: string,
    patch: { title?: string; done?: boolean; attrs?: Record<string, IssueAttrValue> },
  ) => void;
  /** Return the "Unorganized" type-note id, creating it once if absent. */
  ensureUnorganizedType: () => string;
};

export type BacksyncResult = { imported: number; updated: number; truncated: boolean };

/** Cap how many pages (×100 issues) a single back-sync pulls, to bound cost. */
const MAX_PAGES = 5;

/** True when two attribute maps are value-equal (avoids needless re-writes/churn). */
function attrsEqual(
  a: Record<string, IssueAttrValue>,
  b: Record<string, IssueAttrValue>,
): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    const av = a[k];
    const bv = b[k];
    if (Array.isArray(av) || Array.isArray(bv)) {
      if (!Array.isArray(av) || !Array.isArray(bv) || av.length !== bv.length) return false;
      for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

export async function reconcileProjectWithGithub(params: {
  repo: string;
  attributes: AttrDef[];
  /** Every issue filed under this project's type-notes. */
  issues: Issue[];
  actions: BacksyncActions;
}): Promise<BacksyncResult> {
  const { repo, attributes, issues, actions } = params;

  // Local mirrored issues, indexed by their GitHub number.
  const byNumber = new Map<number, Issue>();
  for (const i of issues) if (i.ghNumber != null) byNumber.set(i.ghNumber, i);

  // Pull all issues (state=all) up to the page cap.
  const ghIssues = [] as Awaited<ReturnType<typeof listGithubIssues>>['issues'];
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;
  do {
    const page = await listGithubIssues(repo, cursor);
    ghIssues.push(...page.issues);
    cursor = page.next_cursor ?? undefined;
    pages += 1;
    if (cursor && pages >= MAX_PAGES) {
      truncated = true;
      break;
    }
  } while (cursor);

  let imported = 0;
  let updated = 0;
  for (const gh of ghIssues) {
    const done = githubDone(gh.state);
    const local = byNumber.get(gh.number);
    if (local) {
      const attrs = githubToAttrs(attributes, gh.body, gh.assignees, local.attrs);
      const patch: { title?: string; done?: boolean; attrs?: Record<string, IssueAttrValue> } = {};
      if (gh.title && gh.title !== local.title) patch.title = gh.title;
      if (done !== local.done) patch.done = done;
      if (!attrsEqual(local.attrs, attrs)) patch.attrs = attrs;
      if (Object.keys(patch).length > 0) {
        actions.updateIssue(local.id, patch);
        updated += 1;
      }
    } else {
      const noteId = actions.ensureUnorganizedType();
      const attrs = githubToAttrs(attributes, gh.body, gh.assignees, {});
      const newId = actions.createIssue({
        noteId,
        title: gh.title,
        description: githubIssueDescription(gh.body),
        attrs,
        ghNumber: gh.number,
      });
      // Imported issues arrive done when closed on GitHub.
      if (done) actions.updateIssue(newId, { done: true });
      imported += 1;
    }
  }

  return { imported, updated, truncated };
}
