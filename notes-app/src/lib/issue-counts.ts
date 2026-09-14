/**
 * How many issues a set of issue types holds between them.
 *
 * Split out of the issues store, and split in two, for the reason
 * `folder-tree.ts` is: the rule is worth testing on its own, and the store is a
 * React context that a node-environment test can't mount.
 *
 * Two rules make it worth stating at all:
 *
 * - **An issue can belong to several types at once** (`type_ids`), so a
 *   project's total is not the sum of its types' totals. Adding those up counts
 *   an issue once per type it appears under, and a project card then claims more
 *   issues than the tracker holds — quietly, and only for the projects whose
 *   issues happen to be multi-typed.
 * - **A card counts work still open.** A completed issue is finished business;
 *   leaving it in the total means a project that has been worked down to nothing
 *   still reads as busy, and the number only ever grows. Done issues are dropped
 *   at the index, so nothing downstream can count them back in.
 */
import { effectiveTypeIds } from '@/data/notes';

/** An issue reduced to what counting needs. */
export type CountableIssue = {
  id: string;
  noteId: string;
  typeIds: string[];
  done: boolean;
};

/**
 * Ids of the issues still open, grouped by every type they are filed under.
 * Completed issues never enter the index — see the note above.
 *
 * Built once and shared, because the home grid can render a card per project and
 * each would otherwise scan the whole tracker for a line of subtitle text.
 */
export function indexActiveIssuesByType(
  issues: readonly CountableIssue[],
): Map<string, Set<string>> {
  const byType = new Map<string, Set<string>>();
  for (const issue of issues) {
    if (issue.done) continue;
    for (const typeId of effectiveTypeIds(issue)) {
      const ids = byType.get(typeId);
      if (ids) ids.add(issue.id);
      else byType.set(typeId, new Set([issue.id]));
    }
  }
  return byType;
}

/**
 * Distinct issues in the index filed under any of `typeIds` — that is, the open
 * ones, since the index holds no others.
 *
 * Unions the id sets rather than adding their sizes, which is the whole point:
 * an issue filed under two of these types is one issue.
 */
export function countIssuesInTypes(
  index: ReadonlyMap<string, ReadonlySet<string>>,
  typeIds: readonly string[],
): number {
  const seen = new Set<string>();
  for (const typeId of typeIds) {
    const ids = index.get(typeId);
    if (ids) for (const id of ids) seen.add(id);
  }
  return seen.size;
}
