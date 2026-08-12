/**
 * Deciding which issues go down with a deleted issue-type note.
 *
 * An issue can belong to several types at once (`type_ids`), so losing one of
 * them is not a reason to delete it — it stays live under the types it has
 * left, keeping the trashed type in its list so restoring that type files it
 * back automatically. Only an issue with no live type left to show it comes
 * along with the delete.
 *
 * This lives apart from `db.ts` for the same reason `trash-visibility.ts` does:
 * the rule is worth testing on its own, and the db module pulls in expo-sqlite,
 * which vitest can't load. The rule is split in two around the one thing it
 * can't answer by itself — whether the *other* types an issue belongs to are
 * still live notes, which only the database knows.
 */
import { effectiveTypeIds } from '@/data/notes';

/** An issue reduced to what the decision needs: its id and the types it's in. */
export type IssueMembership = {
  id: string;
  /** Every type-note id this issue belongs to (already fallback-resolved). */
  types: string[];
};

/**
 * The type ids a stored issue row belongs to. Mirrors what the app reads:
 * `type_ids` when it has any, else the single home `note_id`. Corrupt or
 * missing JSON reads as empty and falls back the same way, rather than throwing
 * in the middle of a delete.
 */
export function parseTypeIds(noteId: string, rawTypeIds: string | null): string[] {
  let typeIds: string[] = [];
  try {
    const parsed = JSON.parse(rawTypeIds ?? '[]') as unknown;
    if (Array.isArray(parsed)) typeIds = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // Corrupt JSON reads as no explicit types, so note_id decides.
  }
  return effectiveTypeIds({ noteId, typeIds });
}

/**
 * Works out which issues a delete of `goingIds` has to take with it.
 *
 * Returns the types whose liveness still has to be looked up, and a `doomed`
 * step to call back with the answer. Two phases because the caller has to hit
 * the notes table in between: an issue is spared when *any* type it belongs to
 * outlives this delete, and a type that is already sitting in the trash doesn't
 * count as somewhere the issue could still be seen.
 *
 * Note what is deliberately absent: nothing here rewrites an issue's types. A
 * spared issue keeps the trashed type in its list, so the delete stays
 * reversible — restoring the type puts the issue back under it with no
 * bookkeeping to replay.
 */
export function planIssueCascade(
  issues: IssueMembership[],
  goingIds: string[],
): {
  /** Types held by affected issues that aren't part of this delete. */
  typesToCheck: string[];
  /** Ids of issues to tombstone, given which of `typesToCheck` are live. */
  doomed: (liveTypeIds: Iterable<string>) => string[];
} {
  const going = new Set(goingIds);
  const affected = issues.filter((i) => i.types.some((t) => going.has(t)));
  const typesToCheck = [
    ...new Set(affected.flatMap((i) => i.types).filter((t) => !going.has(t))),
  ];
  return {
    typesToCheck,
    doomed: (liveTypeIds) => {
      const live = new Set(liveTypeIds);
      return affected.filter((i) => !i.types.some((t) => live.has(t))).map((i) => i.id);
    },
  };
}
