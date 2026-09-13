/**
 * Which existing issues a new one is checked against for duplicates.
 *
 * The check rides along with the title request (`POST /issues/title`), so this
 * only decides what goes in the request: earlier live issues from the same
 * project, most likely matches first, capped and trimmed. The server clamps the
 * list again, so these limits are about request size, not correctness.
 *
 * EARLIER ONLY. An issue is compared with issues created before it. Two issues
 * queued offline and flushed together would otherwise each be offered the other
 * and could flag one another.
 *
 * No embeddings, on purpose: shared words are enough to rank a few dozen issues
 * for a model that reads every candidate anyway, and they cost nothing.
 */
import { effectiveTypeIds, type Issue } from '@/data/notes';

export type DuplicateCandidate = { id: string; title: string; description: string; done: boolean };

export const MAX_DUPLICATE_CANDIDATES = 60;
export const CANDIDATE_EXCERPT_CHARS = 300;

/** Lowercased words of three or more letters — short ones match everything. */
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9À-￿]{3,}/g) ?? []);
}

export function selectDuplicateCandidates({
  selfId,
  createdBefore,
  text,
  projectTypeIds,
  issues,
}: {
  selfId: string;
  /** The new issue's creation time; later issues are left out. Omit when every
   *  issue in `issues` is already known to be older. */
  createdBefore?: number;
  text: string;
  /** Every issue type in the new issue's project. */
  projectTypeIds: ReadonlySet<string>;
  /** Live issues. Trashed ones must already be filtered out. */
  issues: readonly Issue[];
}): DuplicateCandidate[] {
  const mine = words(text);
  const scored = issues
    .filter(
      (i) =>
        i.id !== selfId &&
        (createdBefore === undefined || i.createdAt < createdBefore) &&
        effectiveTypeIds(i).some((t) => projectTypeIds.has(t)),
    )
    .map((issue) => {
      let shared = 0;
      for (const w of words(`${issue.title} ${issue.description}`)) if (mine.has(w)) shared += 1;
      return { issue, shared };
    });
  // Most shared words first; then open before done, since a duplicate of
  // something still open is the likelier report; then newest first.
  scored.sort(
    (a, b) =>
      b.shared - a.shared ||
      Number(a.issue.done) - Number(b.issue.done) ||
      b.issue.createdAt - a.issue.createdAt,
  );
  return scored.slice(0, MAX_DUPLICATE_CANDIDATES).map(({ issue }) => ({
    id: issue.id,
    title: issue.title,
    description: issue.description.slice(0, CANDIDATE_EXCERPT_CHARS),
    done: issue.done,
  }));
}
