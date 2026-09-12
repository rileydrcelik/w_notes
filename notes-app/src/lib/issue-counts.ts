/**
 * How many issues a set of issue types holds between them.
 *
 * Split out of the issues store, and split in two, for the reason
 * `folder-tree.ts` is: the rule is worth testing on its own, and the store is a
 * React context that a node-environment test can't mount.
 *
 * The rule that makes it worth stating at all: **an issue can belong to several
 * types at once** (`type_ids`), so a project's total is not the sum of its
 * types' totals. Adding those up counts an issue once per type it appears under,
 * and a project card then claims more issues than the tracker holds — quietly,
 * and only for the projects whose issues happen to be multi-typed.
 */
import { effectiveTypeIds } from '@/data/notes';

/** An issue reduced to what counting needs. */
export type CountableIssue = {
  id: string;
  noteId: string;
  typeIds: string[];
};

/**
 * Issue ids grouped by every type they are filed under.
 *
 * Built once and shared, because the home grid can render a card per project and
 * each would otherwise scan the whole tracker for a line of subtitle text.
 */
export function indexIssuesByType(issues: readonly CountableIssue[]): Map<string, Set<string>> {
  const byType = new Map<string, Set<string>>();
  for (const issue of issues) {
    for (const typeId of effectiveTypeIds(issue)) {
      const ids = byType.get(typeId);
      if (ids) ids.add(issue.id);
      else byType.set(typeId, new Set([issue.id]));
    }
  }
  return byType;
}

/**
 * Distinct issues filed under any of `typeIds`.
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
