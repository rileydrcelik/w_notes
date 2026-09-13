/**
 * Holds back GitHub issue pushes made while offline, and replays them once the
 * device can reach the server again.
 *
 * The task manager mirrors issues to GitHub best-effort: the local write always
 * lands, and the push that follows it either succeeds or is lost. With no
 * connection that second half never happened, so an issue created on a train
 * stayed local for ever while the app said nothing useful. This module is the
 * missing half.
 *
 * WHAT IS STORED IS AN INTENT, NOT A PAYLOAD. An entry names an issue, not the
 * fields to send; the request is rebuilt from the issue's current row at flush
 * time. That is what lets a burst of offline edits collapse into a single entry,
 * and it makes replaying one structurally unable to write a stale value — the
 * queue can only ever push what the issue says *now*. The two flags below are
 * the deliberate exception, and they record intent rather than data.
 *
 * THE QUEUE IS DEVICE-LOCAL, and that is load-bearing rather than incidental. It
 * lives in the `settings` table, which sync never touches. A synced queue would
 * be replayed by every device that pulled it, and since opening an issue is not
 * idempotent, each one would open its own copy. The device that made the edit
 * owns the push.
 */
import type { Issue, IssueAttrValue } from '@/data/notes';
import { db } from '@/lib/db';
import { isDbLockedError } from '@/lib/web-db-lock';
import { AuthUnavailableError } from '@/lib/auth/token';
import { ApiError } from '@/lib/sync/api';
import {
  createGithubIssue,
  findGithubIssueByMarker,
  getGithubIssueDetail,
  githubIssueAssignees,
  githubIssueBody,
  githubIssueLabels,
  githubSyncErrorMessage,
  mergeManagedLabels,
  setGithubIssueState,
  updateGithubIssue,
  upsertAttrsBlock,
} from '@/lib/issue-github';
import type { AttrDef } from '@/lib/project';
import { Sentry } from '@/lib/sentry';

/** The device-local settings key the queue is stored under. */
const STORAGE_KEY = 'github_outbox';

/**
 * The key sync-engine stamps with the Firebase uid this device last synced as
 * ('' while anonymous). Entries carry a copy so a push queued by one account is
 * never replayed under another's credentials — GitHub calls bill the *caller's*
 * own token, and the anonymous device-key user is a different backend user from
 * the signed-in one.
 */
const SYNCED_UID = 'synced_uid';

/**
 * How long an entry may sit unflushed before it is abandoned. A push that has
 * not gone through in a week is not waiting on connectivity any more — the token
 * was revoked, the repo was deleted, the user moved on — and an entry that can
 * never succeed must not be retried for ever, nor grow this blob without bound.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard cap on queue size; the oldest entries are dropped past it. */
const MAX_ENTRIES = 500;

/** Which kind of push was held back. Intent only — values are never stored. */
export type PushFacets = {
  /**
   * The user edited the title/description, so the replay may overwrite what
   * GitHub holds. Without this flag the replay preserves GitHub's body and only
   * refreshes the managed attributes block inside it — because the description
   * is never back-synced, so pushing the local copy unasked would silently
   * destroy an edit made on GitHub.
   */
  details?: true;
  /**
   * The user ticked or un-ticked done, so the replay may push open/closed.
   * Without it the replay leaves state alone, so an attribute edit queued
   * offline cannot reopen an issue somebody closed on GitHub meanwhile.
   */
  state?: true;
  /**
   * The model replaced the issue's stand-in title (see issue-retitle), so the
   * replay may push the title. Title only: unlike `details`, the body GitHub
   * holds is left alone apart from the managed attributes block.
   */
  title?: true;
};

/** One held-back push, keyed by local issue id. */
type PendingMirror = PushFacets & {
  issueId: string;
  /** The project's repo as of enqueue; re-validated against the folder at flush. */
  repo: string;
  /** `synced_uid` at enqueue ('' = anonymous). */
  identity: string;
  queuedAt: number;
  /** Bumped and persisted *before* each attempt — see the adopt-or-create note. */
  attempts: number;
  /**
   * Bumped every time an intent is added. The flush captures it before sending
   * and refuses to drop an entry whose seq has moved on, so an edit queued while
   * that very issue was mid-flight is retried instead of being deleted unsent.
   */
  seq: number;
};

type StoredQueue = { v: 1; entries: PendingMirror[] };

/** What the flush needs from the stores to rebuild a push. */
export type OutboxDeps = {
  /**
   * The project context for an issue, or null when it can't be resolved (the
   * project folder or its type notes are gone) — the entry is then dropped.
   */
  resolve: (issue: Issue) => {
    /** The project folder's repo *now*, which may differ from the entry's. */
    repo?: string;
    attributes: AttrDef[];
    /** Titles of the issue's own live types → the labels to apply. */
    typeTitles: string[];
    /** Every live type title in the project → tells managed labels from foreign. */
    projectTypeNames: string[];
    /** Whether this issue's primary type is GitHub-tracked *now*. */
    connected: boolean;
  } | null;
  /** Record the mirror number, through the store so the UI updates. */
  setGhNumber: (issueId: string, ghNumber: number) => void;
  /**
   * Whether opening this issue on GitHub should wait. True while its AI title is
   * still being written (see issue-retitle): created now, the GitHub issue would
   * carry the stand-in, and back-sync would later copy that over the real title.
   */
  holdCreate?: (issueId: string) => boolean;
  /** Told when GitHub or the backend refused an entry, which is then dropped. */
  onRefused?: (issueId: string, message: string) => void;
};

export type PushOutcome =
  | { status: 'pushed' }
  | { status: 'queued' }
  | { status: 'failed'; message: string };

// ---- State ----

/** The live queue, keyed by issue id. One entry per issue, by construction. */
let entries = new Map<string, PendingMirror>();
/** The in-flight (or settled) hydration. Shared, so a second caller waits for
 *  the first rather than racing past it and reading an empty queue. */
let loading: Promise<void> | null = null;

/**
 * Cached id set handed to `useSyncExternalStore`, which compares by reference —
 * building a fresh Set per call would spin the render loop. Rebuilt only when
 * the queue actually changes.
 */
let idSnapshot: ReadonlySet<string> = new Set();

const listeners = new Set<() => void>();

/**
 * Serializes every read-modify-write of the stored queue.
 *
 * `db.setSetting` is write-serialized but `db.getSetting` is not, so two
 * enqueues racing would each read the same JSON and the second would write back
 * a copy missing the first. That is not hypothetical: turning on tracking for a
 * type backfills all of its issues at once, so an offline backfill fails — and
 * enqueues — N times simultaneously.
 */
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = chain.then(op, op);
  chain = run.catch(() => {});
  return run;
}

function refreshSnapshot(): void {
  idSnapshot = new Set(entries.keys());
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      Sentry.captureException(e, { tags: { source: 'github-outbox', op: 'emit' } });
    }
  }
}

/** Subscribe to queue changes; returns an unsubscribe fn. */
export function subscribeGithubOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Local issue ids whose GitHub push is still held back. Stable reference. */
export function pendingGithubIssueIds(): ReadonlySet<string> {
  return idSnapshot;
}

// ---- Persistence ----

async function persist(): Promise<void> {
  const payload: StoredQueue = { v: 1, entries: [...entries.values()] };
  try {
    await db.setSetting(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    // A follower browser tab can't hold the database. The in-memory queue stays
    // authoritative for this session; the owning tab keeps the durable copy.
    if (isDbLockedError(e)) return;
    Sentry.captureException(e, { tags: { source: 'github-outbox', op: 'persist' } });
  }
}

/** Hydrate the queue from the device. Safe to call more than once. */
export function loadGithubOutbox(): Promise<void> {
  loading ??= hydrate();
  return loading;
}

async function hydrate(): Promise<void> {
  await serialize(async () => {
    try {
      const raw = await db.getSetting(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<StoredQueue>;
      if (!parsed || !Array.isArray(parsed.entries)) return;
      const now = Date.now();
      for (const e of parsed.entries) {
        if (!e || typeof e.issueId !== 'string' || typeof e.repo !== 'string') continue;
        if (typeof e.queuedAt !== 'number' || now - e.queuedAt > MAX_AGE_MS) continue;
        entries.set(e.issueId, {
          issueId: e.issueId,
          repo: e.repo,
          identity: typeof e.identity === 'string' ? e.identity : '',
          queuedAt: e.queuedAt,
          attempts: typeof e.attempts === 'number' ? e.attempts : 0,
          seq: typeof e.seq === 'number' ? e.seq : 1,
          ...(e.details ? { details: true as const } : {}),
          ...(e.state ? { state: true as const } : {}),
          ...(e.title ? { title: true as const } : {}),
        });
      }
      refreshSnapshot();
    } catch (e) {
      if (isDbLockedError(e)) return;
      // A corrupt blob must not wedge the feature; start from empty.
      Sentry.captureException(e, { tags: { source: 'github-outbox', op: 'load' } });
    }
  });
}

/**
 * Drop everything. Called when the local issues are wiped (sign-out, or signing
 * into a different account): every entry names a row that no longer exists, so
 * this is not data loss — the data it referenced went with the user's own
 * request.
 */
export async function clearGithubOutbox(): Promise<void> {
  await serialize(async () => {
    entries = new Map();
    refreshSnapshot();
    await persist();
  });
}

/**
 * Re-stamp entries onto a new identity — used when an anonymous device claims
 * its data into a freshly signed-in account. Same device, same rows, so the
 * queued pushes are still the ones this user asked for.
 *
 * Hydrates first, and deliberately outside `serialize`: the claim runs from
 * `onSignIn`, which can reach this before the runner has loaded the queue, and
 * an empty in-memory map then made this a no-op that left every stored entry
 * stamped with the old identity — for the flush to refuse and drop as another
 * account's. `hydrate` takes the same chain, so awaiting it inside the
 * serialized block would deadlock rather than fix anything.
 */
export async function reassignGithubOutbox(identity: string): Promise<void> {
  await loadGithubOutbox();
  await serialize(async () => {
    if (entries.size === 0) return;
    for (const e of entries.values()) e.identity = identity;
    await persist();
  });
}

// ---- Enqueue ----

/**
 * Whether a failure is worth holding on to.
 *
 * Only a transport failure means "no connection": `apiFetch` throws `ApiError`
 * exclusively for a response the server actually sent, so anything else reaching
 * here is offline/DNS/CORS. `AuthUnavailableError` joins it — the session is
 * mid-restore, which resolves on its own.
 *
 * An `ApiError` is deliberately NOT retryable at the statuses that mean refusal:
 * a bad token now surfaces as 400 and a misconfigured repo as 404/410/422, and
 * silently retrying those for a week would trade one actionable alert for an
 * invisible retry loop. 429 and 504 are the honest exceptions — the request was
 * throttled or timed out, not refused.
 */
export function isRetryable(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 429 || e.status === 504;
  if (e instanceof AuthUnavailableError) return true;
  // An unconfigured build has no server to come back to, so nothing could flush.
  if (e instanceof Error && e.message.includes('EXPO_PUBLIC_API_URL')) return false;
  return true;
}

async function enqueue(
  issueId: string,
  repo: string,
  facets: PushFacets,
  attempted: boolean,
): Promise<void> {
  await serialize(async () => {
    const identity = (await db.getSetting(SYNCED_UID).catch(() => '')) ?? '';
    const existing = entries.get(issueId);
    // OR-merge the intents: an issue edited and then ticked off while offline
    // must replay as both, and it is still a single entry.
    //
    // Mutated in place rather than replaced, so a flush already holding this
    // object sees the new intent instead of pushing the old one and deleting
    // the new.
    if (existing) {
      existing.repo = repo;
      existing.identity = identity;
      existing.seq += 1;
      if (attempted) existing.attempts += 1;
      if (facets.details) existing.details = true;
      if (facets.state) existing.state = true;
      if (facets.title) existing.title = true;
    } else {
      entries.set(issueId, {
        issueId,
        repo,
        identity,
        queuedAt: Date.now(),
        // A push that already went out and failed counts as an attempt. That is
        // exactly the ambiguous case — the request may have reached GitHub with
        // only the reply lost — so the FIRST replay has to go looking for what
        // it might already have created rather than blindly creating again.
        attempts: attempted ? 1 : 0,
        seq: 1,
        ...(facets.details ? { details: true as const } : {}),
        ...(facets.state ? { state: true as const } : {}),
        ...(facets.title ? { title: true as const } : {}),
      });
    }
    if (entries.size > MAX_ENTRIES) {
      const oldest = [...entries.values()].sort((a, b) => a.queuedAt - b.queuedAt);
      for (const e of oldest.slice(0, entries.size - MAX_ENTRIES)) entries.delete(e.issueId);
      Sentry.addBreadcrumb({
        category: 'github-outbox',
        message: `queue capped at ${MAX_ENTRIES}; dropped oldest`,
        level: 'warning',
      });
    }
    refreshSnapshot();
    await persist();
  });
}

/**
 * Run a mirror push, holding it back instead of losing it when the device is
 * offline.
 *
 * Returns `queued` when it was held — the caller should stay silent, since
 * nothing has gone wrong and the issue's own pending badge says so — `failed`
 * with a ready-to-show message when GitHub or the backend actually refused, and
 * `pushed` on success.
 */
export async function pushOrQueue(params: {
  issueId: string;
  repo: string;
  facets?: PushFacets;
  push: () => Promise<void>;
}): Promise<PushOutcome> {
  const { issueId, repo, facets = {}, push } = params;
  try {
    await push();
    return { status: 'pushed' };
  } catch (e) {
    if (!isRetryable(e)) {
      Sentry.captureException(e, { tags: { source: 'github-outbox', op: 'push' } });
      return { status: 'failed', message: githubSyncErrorMessage(e) };
    }
    await enqueue(issueId, repo, facets, true);
    Sentry.addBreadcrumb({
      category: 'github-outbox',
      message: `held back GitHub push for ${issueId}`,
      level: 'info',
    });
    return { status: 'queued' };
  }
}

/**
 * Queue a push without attempting it first — for a caller that already knows the
 * connection is down, such as a batch that stopped issuing after its first
 * transport failure.
 */
export async function queueGithubPush(
  issueId: string,
  repo: string,
  facets: PushFacets = {},
): Promise<void> {
  await enqueue(issueId, repo, facets, false);
}

// ---- Flush ----

export type FlushResult = { pushed: number; dropped: number; remaining: number };

let flushing: Promise<FlushResult> | null = null;

async function drop(issueId: string, why: string): Promise<void> {
  await serialize(async () => {
    if (!entries.delete(issueId)) return;
    Sentry.addBreadcrumb({
      category: 'github-outbox',
      message: `dropped ${issueId}: ${why}`,
      level: 'info',
    });
    refreshSnapshot();
    await persist();
  });
}

/** Record that this entry still owes GitHub a state change or a title. */
async function markIntent(entry: PendingMirror, facet: 'state' | 'title'): Promise<void> {
  await serialize(async () => {
    const live = entries.get(entry.issueId);
    if (!live || live[facet]) return;
    live[facet] = true;
    entry[facet] = true;
    await persist();
  });
}

async function bumpAttempts(entry: PendingMirror): Promise<void> {
  await serialize(async () => {
    const live = entries.get(entry.issueId);
    if (!live) return;
    live.attempts += 1;
    entry.attempts = live.attempts;
    await persist();
  });
}

/**
 * Replay every held-back push. Concurrent calls share one run.
 *
 * Entries are replayed one at a time and the run stops at the first retryable
 * failure: if the connection went away again, the rest will fail the same way,
 * and hammering them only burns battery and rate limit.
 */
export function flushGithubOutbox(deps: OutboxDeps): Promise<FlushResult> {
  if (flushing) return flushing;
  flushing = runFlush(deps).finally(() => {
    flushing = null;
  });
  return flushing;
}

/** The app shell's store readers, registered by `GithubOutboxRunner`. */
let registeredDeps: OutboxDeps | null = null;

export function setGithubOutboxDeps(deps: OutboxDeps | null): void {
  registeredDeps = deps;
}

/**
 * Flush now, from a screen that doesn't hold the stores' readers — the New issue
 * screen, once it has queued a create. Resolves null when no runner is mounted.
 *
 * Waits out a flush already running instead of sharing it: that run took its
 * snapshot before this caller's entry existed, so sharing it would resolve
 * without ever trying the entry the caller is waiting on.
 */
export async function flushGithubOutboxNow(
  onRefused?: OutboxDeps['onRefused'],
): Promise<FlushResult | null> {
  const deps = registeredDeps;
  if (!deps) return null;
  if (flushing) await flushing.catch(() => {});
  return flushGithubOutbox(onRefused ? { ...deps, onRefused } : deps);
}

type ResolvedContext = NonNullable<ReturnType<OutboxDeps['resolve']>>;

async function runFlush(deps: OutboxDeps): Promise<FlushResult> {
  await loadGithubOutbox();
  let pushed = 0;
  let dropped = 0;
  if (entries.size === 0) return { pushed, dropped, remaining: 0 };

  const identity = (await db.getSetting(SYNCED_UID).catch(() => '')) ?? '';

  for (const snapshot of [...entries.values()]) {
    // Re-read: the queue may have been cleared (sign-out) mid-run, and a fresh
    // intent may have landed on this very issue since the loop started.
    const entry = entries.get(snapshot.issueId);
    if (!entry) continue;

    if (entry.identity !== identity) {
      await drop(entry.issueId, 'queued under a different account');
      dropped += 1;
      continue;
    }
    if (Date.now() - entry.queuedAt > MAX_AGE_MS) {
      await drop(entry.issueId, 'expired');
      dropped += 1;
      continue;
    }

    let row: (Issue & { deletedAt: number | null }) | null;
    try {
      row = await db.getIssueById(entry.issueId);
    } catch (e) {
      if (isDbLockedError(e)) break; // follower tab; the owning tab will flush
      throw e;
    }
    if (!row) {
      await drop(entry.issueId, 'issue no longer exists');
      dropped += 1;
      continue;
    }
    // Trashed, but restorable — the type-delete cascade tombstones issues and a
    // restore brings them back. Hold rather than drop; the TTL is the backstop.
    if (row.deletedAt != null) continue;

    const ctx = deps.resolve(row);
    if (!ctx) {
      await drop(entry.issueId, 'project no longer resolvable');
      dropped += 1;
      continue;
    }
    if (!ctx.repo || ctx.repo !== entry.repo) {
      // The project was re-pointed at another repo. An issue number means nothing
      // across repos, so pushing there would rewrite an unrelated issue.
      await drop(entry.issueId, 'project repo changed');
      dropped += 1;
      continue;
    }

    // What this replay is about to satisfy. Anything queued after this point
    // moves the seq on, and must survive the drop below.
    const seqSent = entry.seq;
    try {
      const outcome = await replay(entry, row, ctx, deps);
      if (outcome === 'pushed') {
        pushed += 1;
        if (entries.get(entry.issueId)?.seq === seqSent) {
          await drop(entry.issueId, 'pushed');
        }
      } else if (outcome === 'dropped') {
        // replay() abandoned it and has already dropped the entry.
        dropped += 1;
      }
      // 'held': left queued, untouched, for a later flush.
    } catch (e) {
      if (isRetryable(e)) break; // still offline — leave the rest queued
      Sentry.captureException(e, {
        tags: { source: 'github-outbox', op: 'flush', attempts: String(entry.attempts) },
      });
      const message = githubSyncErrorMessage(e);
      await drop(entry.issueId, `refused: ${message}`);
      dropped += 1;
      deps.onRefused?.(entry.issueId, message);
    }
  }

  return { pushed, dropped, remaining: entries.size };
}

/** Push one entry. `dropped` when it was abandoned rather than sent (and already
 *  dropped), so the caller doesn't count it as delivered; `held` when it must
 *  wait and was left untouched. */
async function replay(
  entry: PendingMirror,
  row: Issue,
  ctx: ResolvedContext,
  deps: OutboxDeps,
): Promise<'pushed' | 'dropped' | 'held'> {
  const repo = entry.repo;
  const attrs: Record<string, IssueAttrValue> = row.attrs;
  const assignees = githubIssueAssignees(ctx.attributes, attrs);

  if (row.ghNumber == null) {
    // Tracking was turned off while this waited. "Stop tracking on GitHub" is an
    // explicit, later instruction and outranks the queued intent.
    if (!ctx.connected) {
      await drop(entry.issueId, 'type no longer tracked on GitHub');
      return 'dropped';
    }
    // Its title is still being written. Checked before the attempt is bumped:
    // nothing has gone out, so a later replay has nothing to look for.
    if (deps.holdCreate?.(row.id)) return 'held';
    // Bump BEFORE the request. A crash between the POST and the bookkeeping is
    // the same ambiguous case as a lost response, and both have to come back as
    // a retry that looks for what it may already have created.
    await bumpAttempts(entry);
    let number: number | null = null;
    if (entry.attempts > 1) {
      number = await findGithubIssueByMarker(repo, row.id);
    }
    if (number == null) {
      number = await createGithubIssue(repo, {
        title: row.title,
        body: githubIssueBody(row.description, ctx.attributes, attrs, row.id),
        labels: githubIssueLabels(ctx.typeTitles),
        assignees,
      });
    }
    deps.setGhNumber(row.id, number);
    // Renamed while the create was out: that rename went nowhere, since the
    // edit sheet only pushes an issue that already has a number, and back-sync
    // would soon copy the title just sent over it. Same record-the-intent-first
    // shape as the close below, so a failed follow-up is retried, not forgotten.
    const fresh = await db.getIssueById(row.id).catch(() => null);
    if (fresh && fresh.title !== row.title) {
      await markIntent(entry, 'title');
      await updateGithubIssue(repo, number, { title: fresh.title || 'Untitled issue' });
    }
    // Created *and* completed while offline: the create carries no state, so the
    // close is a second call. Record the intent first — the issue now has a
    // number, so a retry takes the update branch, and without the flag that
    // branch omits `state` and the completion would be lost for good.
    if (row.done) {
      await markIntent(entry, 'state');
      await setGithubIssueState(repo, number, true);
    }
    return 'pushed';
  }

  await bumpAttempts(entry);
  const { labels: current, body: currentBody } = await getGithubIssueDetail(repo, row.ghNumber);
  const labels = mergeManagedLabels(
    current,
    githubIssueLabels(ctx.typeTitles),
    ctx.attributes,
    ctx.projectTypeNames,
  );
  const body = entry.details
    ? (githubIssueBody(row.description, ctx.attributes, attrs, row.id) ?? '')
    : upsertAttrsBlock(currentBody, ctx.attributes, attrs, row.id);
  await updateGithubIssue(repo, row.ghNumber, {
    labels,
    assignees,
    body,
    ...(entry.details || entry.title ? { title: row.title || 'Untitled issue' } : {}),
    ...(entry.state
      ? row.done
        ? { state: 'closed' as const, stateReason: 'completed' }
        : { state: 'open' as const }
      : {}),
  });
  return 'pushed';
}
