/**
 * The autofix chips that survive a reload.
 *
 * Pressing Fix on a Sentry issue dispatches a GitHub Actions run that takes
 * minutes, and the screen shows its progress as a chip on the card — "Sending to
 * autofix…", "Queued…", "PR #12 open". That progress used to live only in the
 * screen's React state, so a web reload (or simply leaving the screen) wiped
 * every chip while the pipeline carried on running on GitHub. Reloading also
 * kills the in-flight dispatch request, but by then the server has already fired
 * the workflow — what's actually lost is the client's memory of having asked.
 *
 * So progress is mirrored into the local `settings` table, one JSON blob per
 * Sentry note. Two deliberate choices:
 *
 * - It is **not** synced. This is a cached view of GitHub state, rebuildable by
 *   polling, and syncing it would strand a "Fixing…" chip on a device that never
 *   pressed Fix — with no timer running there to ever resolve it.
 * - Restored entries come back **unstopped**, with their polling budget reset.
 *   A fix that ran out of poll attempts while you were away deserves another
 *   window rather than a permanent "Still working — check GitHub".
 */

// Backend /sentry/autofix responses.
export type AutofixStatusState =
  | 'none'
  | 'branch_created'
  | 'pr_open'
  | 'pr_merged'
  | 'pr_closed'
  // The run finished without pushing anything: the agent judged that no code
  // change was warranted, or the run itself failed. Terminal, and the run is the
  // only place its reasoning can be read — so it carries `run_url`, not a PR.
  | 'no_fix'
  // Same run, but the issue was also closed in Sentry: the fix is already on
  // main *and* the error hasn't fired since that code deployed. Both halves are
  // required — an error still arriving against correct code is `no_fix`, and
  // saying "already fixed" there would silence a live outage.
  | 'dismissed';
export type AutofixStatus = {
  state: AutofixStatusState;
  branch: string;
  pr_number?: number | null;
  pr_url?: string | null;
  title?: string | null;
  run_url?: string | null;
  run_conclusion?: string | null;
};

/** Per-issue autofix progress, keyed by Sentry issue id on the screen. */
export type FixState = {
  phase: 'dispatching' | 'error' | 'tracking';
  shortId?: string;
  status?: AutofixStatus;
  stopped?: boolean; // polling gave up (timeout); keep the last status shown
  message?: string;
};

/**
 * A fix is still "in flight" (worth polling) until a PR shows up, the run ends
 * with nothing to show (`no_fix`), or we give up. Only the two non-terminal
 * states poll, so a new terminal state stops the timer by being listed nowhere.
 */
export function isPollable(fix: FixState | undefined): boolean {
  return (
    !!fix &&
    fix.phase === 'tracking' &&
    !fix.stopped &&
    !!fix.shortId &&
    (fix.status?.state === 'none' || fix.status?.state === 'branch_created')
  );
}

/**
 * How long a stored chip stays meaningful. Past this the PR has long since been
 * merged or abandoned, and a chip that never expires would follow an issue
 * around forever.
 */
export const FIX_TTL_MS = 24 * 60 * 60 * 1000;

/** Settings key holding one Sentry note's autofix progress. */
export function fixStorageKey(noteId: string): string {
  return `sentryFix.${noteId}`;
}

type StoredFix = FixState & { ts: number };

/**
 * JSON for the `settings` row.
 *
 * Every entry is stamped with the time of *this write*, not of its own last
 * change — the map is persisted whole, so one fix still being polled keeps the
 * whole note's chips alive. That makes the TTL below "a day since anything on
 * this note moved" rather than "a day since this chip resolved", which is the
 * looser of the two readings and the one to hold in mind when reading it.
 */
export function serializeFixes(fixes: Record<string, FixState>, now: number): string {
  const out: Record<string, StoredFix> = {};
  for (const [issueId, fix] of Object.entries(fixes)) out[issueId] = { ...fix, ts: now };
  return JSON.stringify(out);
}

/**
 * Rebuild the screen's fix map from a stored row, dropping anything expired or
 * malformed. A corrupt blob yields an empty map rather than throwing — losing
 * the chips is a cosmetic regression, taking the screen down with it isn't.
 */
export function parseFixes(raw: string | null | undefined, now: number): Record<string, FixState> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: Record<string, FixState> = {};
  for (const [issueId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const { ts, stopped, ...fix } = value as StoredFix;
    if (typeof ts !== 'number' || now - ts > FIX_TTL_MS) continue;
    if (fix.phase !== 'dispatching' && fix.phase !== 'error' && fix.phase !== 'tracking') continue;
    // `stopped` is dropped on purpose: see the note on polling budgets above.
    out[issueId] = fix;
  }
  return out;
}

/**
 * Pick up fixes that were mid-dispatch when the screen went away. Their POST
 * can't be awaited any more, but the autofix branch name is a pure function of
 * the issue's short id — which the issue list already carries — so the status
 * poll can find the run without it. Anything whose short id we don't have stays
 * as it is.
 *
 * Returns the same object when nothing changed, so callers can hand it straight
 * to `setState` without re-rendering on every list refresh.
 */
export function resumeDispatching(
  fixes: Record<string, FixState>,
  issues: { id: string; shortId?: string | null }[],
): Record<string, FixState> {
  let next: Record<string, FixState> | null = null;
  for (const issue of issues) {
    const fix = fixes[issue.id];
    if (!fix || fix.phase !== 'dispatching' || !issue.shortId) continue;
    next ??= { ...fixes };
    next[issue.id] = { phase: 'tracking', shortId: issue.shortId };
  }
  return next ?? fixes;
}
