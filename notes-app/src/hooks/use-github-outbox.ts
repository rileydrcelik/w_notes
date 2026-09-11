/**
 * Which issues still have a GitHub push waiting for a connection.
 *
 * Device-local session state, so it is read from the outbox module rather than
 * carried on the `Issue` itself: a field would either sync — telling another
 * device an issue is "pending" for a push it cannot make — or be a phantom the
 * database can't populate and the next pull would flatten.
 */
import { useSyncExternalStore } from 'react';

import { pendingGithubIssueIds, subscribeGithubOutbox } from '@/lib/github-outbox';

/** Stable empty set for the server/initial snapshot — a fresh one would loop. */
const EMPTY: ReadonlySet<string> = new Set();

export function usePendingGithubIssues(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeGithubOutbox, pendingGithubIssueIds, () => EMPTY);
}
