/**
 * Issues composed on a GitHub plugin note that haven't reached GitHub yet.
 *
 * The sibling queue in `github-outbox.ts` holds back pushes for issues the task
 * manager already stored locally. It can store an *intent* — an entry names a
 * row and the request is rebuilt from that row at flush time — because the data
 * is safe in SQLite either way. This surface has no row: the plugin note renders
 * the repo's live issues straight from GitHub, so a composed issue exists only
 * in the compose form until the POST succeeds. Offline, it used to exist nowhere
 * at all the moment the sheet closed.
 *
 * So an entry here carries the payload, and that changes the rules:
 *
 * - **Nothing is dropped silently.** Every abandon path in the intent queue is
 *   justified by "the row it names is still on the device". Here the entry *is*
 *   the user's text, so a refusal, an expiry or an account switch marks it
 *   {@link GithubIssueDraft.failure} and keeps it. Only the user discards.
 * - **A row each, not one blob.** The intent queue is one JSON value rewritten
 *   whole, and an unparseable byte costs it everything — recoverable, since its
 *   entries are pointers. Losing every draft is not, so each lives under its own
 *   `settings` key and one bad value costs exactly one draft.
 *
 * Like the intent queue this is device-local and deliberately unsynced: opening
 * an issue is not idempotent, so a queue every device pulled would have each of
 * them open its own copy. `settings` is already excluded from `SyncPayload`,
 * `markAllDirty` and `clearAllData` (see `db.ts`), which is also what lets a
 * draft survive the sign-out those two perform.
 */
import { db } from '@/lib/db';
import { isRetryable } from '@/lib/github-outbox';
import {
  createGithubIssue,
  findGithubIssueByMarker,
  githubIssueBody,
  githubSyncErrorMessage,
} from '@/lib/issue-github';
import { Sentry } from '@/lib/sentry';
import { ApiError } from '@/lib/sync/api';
import { isDbLockedError } from '@/lib/web-db-lock';

/** Every draft key starts with this; one `settings` row per draft. */
const KEY_PREFIX = 'github_draft:';

/** Mirrors `github-outbox.ts` — the uid this device last synced as ('' = anonymous). */
const SYNCED_UID = 'synced_uid';

/**
 * Hard cap on stored drafts, oldest first.
 *
 * Far smaller than the intent queue's 500: a draft is typed by hand, one at a
 * time, and the compose sheet rebinds to the pending draft for a repo rather
 * than stacking a new one. Reaching this at all means something is wrong, so the
 * cap is a backstop against unbounded growth, not a working limit — and past it
 * the oldest is marked {@link GithubIssueDraft.failure}, never deleted.
 */
const MAX_DRAFTS = 50;

/** A composed issue waiting to reach GitHub. */
export type GithubIssueDraft = {
  /**
   * Client-minted, and also the id written into the body as a marker. Minted
   * before the *first* attempt, not on retry: the ambiguous case is a POST that
   * reached GitHub with only its response lost, and a retry can only adopt what
   * the first attempt marked.
   */
  id: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  milestone: number | null;
  /** The uid this was composed under; a draft is never filed as another account. */
  identity: string;
  queuedAt: number;
  attempts: number;
  /**
   * Why this can't be sent as it stands, when it can't. The text is kept
   * regardless — this marks a draft as needing the user rather than the network,
   * and is what stands in for the intent queue's silent `drop`.
   */
  failure?: string;
};

/** What the compose sheet hands over; the rest is bookkeeping. */
export type DraftInput = Pick<
  GithubIssueDraft,
  'repo' | 'title' | 'body' | 'labels' | 'assignees' | 'milestone'
>;

let drafts = new Map<string, GithubIssueDraft>();
let loading: Promise<void> | null = null;
let snapshot: readonly GithubIssueDraft[] = [];
const listeners = new Set<() => void>();

/**
 * No write-serialization chain, unlike `github-outbox.ts`.
 *
 * That chain exists because the whole queue is one value: two enqueues would
 * each read the blob and the second would write back a copy missing the first.
 * A draft owns its own key, so concurrent writes touch different rows, and
 * `db.setSetting`/`db.deleteSetting` are already write-serialized one layer
 * down. The in-memory map is only ever mutated synchronously, between awaits.
 */
function key(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function refresh(): void {
  snapshot = [...drafts.values()].sort((a, b) => a.queuedAt - b.queuedAt);
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      Sentry.captureException(e, { tags: { source: 'github-drafts', op: 'emit' } });
    }
  }
}

/** Subscribe to draft changes; returns an unsubscribe fn. */
export function subscribeGithubDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every stored draft, oldest first. Stable reference between changes. */
export function githubDrafts(): readonly GithubIssueDraft[] {
  return snapshot;
}

/**
 * The draft the compose sheet should reopen with for this repo, if any.
 *
 * One per repo by construction: submitting while a draft is pending updates it
 * rather than queueing a second. Without that, a user who reopens the sheet
 * offline to fix a typo files two issues once the connection returns.
 */
export function pendingDraftForRepo(repo: string): GithubIssueDraft | undefined {
  return snapshot.find((d) => d.repo === repo && !d.failure);
}

// ---- Persistence ----

function parse(raw: string): GithubIssueDraft | null {
  const d = JSON.parse(raw) as Partial<GithubIssueDraft>;
  if (!d || typeof d.id !== 'string' || typeof d.repo !== 'string') return null;
  if (typeof d.title !== 'string' || typeof d.queuedAt !== 'number') return null;
  return {
    id: d.id,
    repo: d.repo,
    title: d.title,
    body: typeof d.body === 'string' ? d.body : '',
    labels: Array.isArray(d.labels) ? d.labels.filter((l) => typeof l === 'string') : [],
    assignees: Array.isArray(d.assignees) ? d.assignees.filter((a) => typeof a === 'string') : [],
    milestone: typeof d.milestone === 'number' ? d.milestone : null,
    identity: typeof d.identity === 'string' ? d.identity : '',
    queuedAt: d.queuedAt,
    attempts: typeof d.attempts === 'number' ? d.attempts : 0,
    ...(typeof d.failure === 'string' && d.failure ? { failure: d.failure } : {}),
  };
}

async function persist(draft: GithubIssueDraft): Promise<void> {
  try {
    await db.setSetting(key(draft.id), JSON.stringify(draft));
  } catch (e) {
    // A follower browser tab can't hold the database; the owning tab keeps the
    // durable copy and this session's map stays authoritative meanwhile.
    if (isDbLockedError(e)) return;
    Sentry.captureException(e, { tags: { source: 'github-drafts', op: 'persist' } });
  }
}

/** Hydrate from the device. Safe to call more than once. */
export function loadGithubDrafts(): Promise<void> {
  loading ??= hydrate();
  return loading;
}

async function hydrate(): Promise<void> {
  try {
    const rows = await db.listSettings(KEY_PREFIX);
    for (const row of rows) {
      // Per row, so one unreadable draft costs only itself. This is the whole
      // reason a draft isn't a member of one shared blob.
      try {
        const draft = parse(row.value);
        if (draft) drafts.set(draft.id, draft);
      } catch (e) {
        Sentry.captureException(e, { tags: { source: 'github-drafts', op: 'parse' } });
      }
    }
    refresh();
  } catch (e) {
    if (isDbLockedError(e)) return;
    Sentry.captureException(e, { tags: { source: 'github-drafts', op: 'load' } });
  }
}

// ---- Mutating ----

/**
 * Store a composed issue that couldn't be sent, under an id already minted for
 * its body marker. Replaces any draft with the same id, which is how an edit to
 * a pending draft stays one entry.
 */
export async function saveGithubDraft(id: string, input: DraftInput): Promise<void> {
  await loadGithubDrafts();
  const existing = drafts.get(id);
  const identity = (await db.getSetting(SYNCED_UID).catch(() => '')) ?? '';
  const draft: GithubIssueDraft = {
    id,
    ...input,
    identity: existing?.identity ?? identity,
    queuedAt: existing?.queuedAt ?? Date.now(),
    attempts: existing?.attempts ?? 0,
  };
  drafts.set(id, draft);
  refresh();
  await persist(draft);
  await enforceCap();
}

/**
 * Past the cap, mark the oldest rather than deleting them. Growing without
 * bound is a bug; deleting what someone wrote to stay tidy is a worse one.
 */
async function enforceCap(): Promise<void> {
  const live = snapshot.filter((d) => !d.failure);
  if (live.length <= MAX_DRAFTS) return;
  for (const draft of live.slice(0, live.length - MAX_DRAFTS)) {
    await markFailed(draft.id, 'Too many unsent drafts on this device.');
  }
}

/** Remove a draft for good. Only ever at the user's request. */
export async function discardGithubDraft(id: string): Promise<void> {
  await loadGithubDrafts();
  if (!drafts.delete(id)) return;
  refresh();
  try {
    await db.deleteSetting(key(id));
  } catch (e) {
    if (isDbLockedError(e)) return;
    Sentry.captureException(e, { tags: { source: 'github-drafts', op: 'discard' } });
  }
}

/** Mark a draft as needing the user rather than the network. Keeps the text. */
async function markFailed(id: string, reason: string): Promise<void> {
  const draft = drafts.get(id);
  if (!draft || draft.failure === reason) return;
  const next = { ...draft, failure: reason };
  drafts.set(id, next);
  refresh();
  Sentry.addBreadcrumb({
    category: 'github-drafts',
    message: `draft held: ${reason}`,
    level: 'info',
  });
  await persist(next);
}

async function bumpAttempts(id: string): Promise<void> {
  const draft = drafts.get(id);
  if (!draft) return;
  const next = { ...draft, attempts: draft.attempts + 1 };
  drafts.set(id, next);
  await persist(next);
}

/**
 * Re-stamp drafts onto a newly claimed account — the anonymous device's own
 * text, now this user's. Mirrors `reassignGithubOutbox`, including hydrating
 * first: the claim runs off the auth callback and can beat the runner's load.
 */
export async function reassignGithubDrafts(identity: string): Promise<void> {
  await loadGithubDrafts();
  for (const draft of [...drafts.values()]) {
    if (draft.identity === identity) continue;
    const next = { ...draft, identity };
    drafts.set(draft.id, next);
    await persist(next);
  }
  refresh();
}

/**
 * Signing into a *different* account, or out.
 *
 * The intent queue clears here, because the rows its entries name were just
 * wiped. A draft is not a pointer, so clearing would delete text this user
 * typed as a side effect of switching accounts. It is held instead: GitHub
 * calls bill the caller's own token, so it genuinely can't be filed as whoever
 * signs in next, but it is still there to recover.
 */
export async function holdGithubDraftsForAccountChange(): Promise<void> {
  await loadGithubDrafts();
  for (const draft of [...drafts.values()]) {
    await markFailed(draft.id, 'Composed while signed in as a different account.');
  }
}

// ---- Flush ----

export type DraftFlushResult = { sent: number; held: number; remaining: number };

let flushing: Promise<DraftFlushResult> | null = null;

/**
 * Send what can be sent, oldest first.
 *
 * Stops at the first retryable failure: if the connection went away again the
 * rest fail identically, and walking them only burns battery and rate limit.
 */
export function flushGithubDrafts(): Promise<DraftFlushResult> {
  flushing ??= runFlush().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function runFlush(): Promise<DraftFlushResult> {
  await loadGithubDrafts();
  let sent = 0;
  let held = 0;
  if (drafts.size === 0) return { sent, held, remaining: 0 };

  const identity = (await db.getSetting(SYNCED_UID).catch(() => '')) ?? '';

  for (const queued of snapshot) {
    // Re-read: a draft may have been edited or discarded since the loop began.
    const draft = drafts.get(queued.id);
    if (!draft || draft.failure) continue;

    if (draft.identity !== identity) {
      await markFailed(draft.id, 'Composed while signed in as a different account.');
      held += 1;
      continue;
    }

    try {
      await send(draft);
      await discardGithubDraft(draft.id);
      sent += 1;
    } catch (e) {
      if (isRetryable(e)) break;
      Sentry.captureException(e, { tags: { source: 'github-drafts', op: 'flush' } });
      await markFailed(draft.id, githubSyncErrorMessage(e));
      held += 1;
    }
  }

  return { sent, held, remaining: drafts.size };
}

/**
 * One create, made safe to repeat.
 *
 * `POST /github/issues` has no idempotency key, and a transport failure cannot
 * be told apart from a create whose response was lost — so a blind retry opens a
 * second issue. Every attempt writes the draft's id into the body as a marker
 * and a retry looks for that marker first, adopting what it finds. `attempts` is
 * bumped *before* the request, so a crash between the two still counts as an
 * attempt and the next pass searches rather than creates.
 */
async function send(draft: GithubIssueDraft): Promise<void> {
  const retry = draft.attempts > 0;
  await bumpAttempts(draft.id);

  if (retry) {
    const found = await findGithubIssueByMarker(draft.repo, draft.id);
    if (found != null) return;
  }

  const body = githubIssueBody(draft.body, undefined, undefined, draft.id);
  try {
    await createGithubIssue(draft.repo, {
      title: draft.title,
      ...(body ? { body } : {}),
      ...(draft.labels.length ? { labels: draft.labels } : {}),
      ...(draft.assignees.length ? { assignees: draft.assignees } : {}),
      ...(draft.milestone != null ? { milestone: draft.milestone } : {}),
    });
  } catch (e) {
    // A label renamed, an assignee removed from the repo or a closed milestone
    // all answer 422, and all of them are the *pickers* going stale while the
    // draft sat queued — not anything wrong with what the user wrote. Losing
    // their text over a label is the worst trade available here, so retry once
    // with the decorations stripped and keep the words.
    if (!(e instanceof ApiError) || e.status !== 422) throw e;
    if (!draft.labels.length && !draft.assignees.length && draft.milestone == null) throw e;
    await createGithubIssue(draft.repo, {
      title: draft.title,
      ...(body ? { body } : {}),
    });
  }
}
