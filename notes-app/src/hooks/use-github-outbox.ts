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
import {
  githubDrafts,
  subscribeGithubDrafts,
  type GithubIssueDraft,
} from '@/lib/github-issue-drafts';

/** Stable empty set for the server/initial snapshot — a fresh one would loop. */
const EMPTY: ReadonlySet<string> = new Set();

export function usePendingGithubIssues(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeGithubOutbox, pendingGithubIssueIds, () => EMPTY);
}

/** Stable empty list for the server/initial snapshot. */
const NO_DRAFTS: readonly GithubIssueDraft[] = [];

/**
 * Issues composed on a GitHub plugin note that haven't reached GitHub yet.
 *
 * Separate from the pending set above because the two mean different things: an
 * entry there is an issue that exists locally and whose mirror is late, while one
 * of these does not exist anywhere but here.
 */
export function useGithubDrafts(): readonly GithubIssueDraft[] {
  return useSyncExternalStore(subscribeGithubDrafts, githubDrafts, () => NO_DRAFTS);
}
