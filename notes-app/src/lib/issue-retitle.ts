/**
 * Replaces a new issue's stand-in title with one the model writes — now if the
 * server can be reached, otherwise on the next sync that gets through.
 *
 * An issue is saved the moment Create is pressed, titled with the first line of
 * what was typed (`stubIssueTitle`). This module owns the second half: asking
 * `POST /issues/title` for a real title and swapping it in. Saving never waits
 * on the model, so creating an issue on a train works exactly as it did.
 *
 * THE STAND-IN IS THE LOCK. An entry remembers the stand-in it was queued with,
 * and the model's title lands only while the issue still carries it. The final
 * check and the write are one conditional statement on SQLite's serialized
 * write chain (`db.setIssueTitleIfStub`), so a hand rename queued a moment
 * earlier has already committed when the condition runs, and wins. Opening the
 * issue in the edit sheet cancels the entry outright (`cancelIssueRetitle`).
 *
 * WHAT IS STORED IS AN INTENT. The text sent is the issue's description at flush
 * time, read from the row, so an offline edit to it is what gets named.
 *
 * THE QUEUE IS DEVICE-LOCAL, like the GitHub outbox and for the same reason: it
 * lives in `settings`, which sync never touches. A synced queue would be flushed
 * by every device that pulled it, each one billing the account's Anthropic key
 * for the same title.
 *
 * GIVING UP KEEPS THE STAND-IN. No key (402), a refusal (422), text too long
 * (413) — none of those change by waiting, so the entry is dropped and the
 * first-line title simply stays. It is a perfectly usable title.
 *
 * GITHUB WAITS FOR IT. While an issue is titling (`isRetitlePending`), the
 * outbox holds back opening it on GitHub, so the stand-in never becomes the
 * GitHub title that back-sync would later copy over the real one.
 *
 * DUPLICATES RIDE ALONG. The same request carries earlier issues from the
 * project (`deps.candidates`, read fresh at request time) and may come back
 * naming one as a likely duplicate. That verdict follows this entry's lifecycle
 * exactly — cancelled, given up on or renamed before the request went out, and
 * no check happens. It is recorded BEFORE the title: if the app dies between the
 * two writes, the stand-in is still there, so the retry asks again and the
 * set-once flag refuses a second write. The other order would leave a real
 * title, which drops the entry, and lose the verdict for good.
 */
import { AuthUnavailableError } from '@/lib/auth/token';
import { db } from '@/lib/db';
import { serializedPerProfile } from '@/lib/profile-lock';
import type { DuplicateCandidate } from '@/lib/issue-duplicates';
import { requestIssueTitle } from '@/lib/issue-title';
import { Sentry } from '@/lib/sentry';
import { ApiError } from '@/lib/sync/api';
import { isDbLockedError, ownsBackgroundWork } from '@/lib/web-db-lock';

/** The device-local settings key the queue is stored under. */
const STORAGE_KEY = 'issue_retitle_queue';

/** Firebase uid this device last synced as ('' while anonymous) — see github-outbox. */
const SYNCED_UID = 'synced_uid';

/** An entry this old stopped waiting on connectivity a long time ago. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard cap on queue size; the oldest entries are dropped past it. */
const MAX_ENTRIES = 500;

/**
 * Requests per entry before the stand-in is kept for good. A 5xx that survives
 * five syncs is not a blip, and each 504 may have been billed.
 */
const MAX_ATTEMPTS = 5;

type PendingRetitle = {
  issueId: string;
  /** The title the issue was saved with; the model's title replaces only this. */
  stub: string;
  /** `synced_uid` at enqueue ('' = anonymous). */
  identity: string;
  queuedAt: number;
  attempts: number;
};

type StoredQueue = { v: 1; entries: PendingRetitle[] };

export type RetitleDeps = {
  /**
   * Swap the stand-in for `title`, only if the issue still carries the stand-in
   * and isn't trashed; resolve whether it did. The issues store's
   * `applyTitleIfStub`, which is one conditional SQLite write.
   */
  applyTitle: (issueId: string, stub: string, title: string) => Promise<boolean>;
  /**
   * Runs after the title is applied and before the entry is dropped — so an
   * issue whose title is still on its way to a GitHub mirror stays "pending" to
   * back-sync until that push has at least been queued.
   */
  onRetitled?: (issueId: string, title: string) => Promise<void> | void;
  /**
   * Earlier issues from the same project to check this one against. A throw
   * means "check against nothing" — it never holds the title back.
   */
  candidates?: (
    issueId: string,
    text: string,
  ) => Promise<DuplicateCandidate[]> | DuplicateCandidate[];
  /**
   * Record the verdict, only if the issue has none yet and both issues are live
   * (the issues store's `applyDuplicateIfUnset`). Resolves whether it did.
   */
  applyDuplicate?: (issueId: string, duplicateOf: string) => Promise<boolean>;
};

export type RetitleOutcome =
  | { status: 'titled'; title: string }
  /** Couldn't reach the server; will retry on a later sync. */
  | { status: 'queued' }
  /** Won't be retitled; the stand-in stays. */
  | { status: 'kept' };

/** What one attempt did — `offline` also tells a flush to stop. */
type AttemptResult = { kind: 'titled'; title: string } | { kind: 'kept' | 'held' | 'offline' };

const KEPT: AttemptResult = { kind: 'kept' };
const HELD: AttemptResult = { kind: 'held' };
const OFFLINE: AttemptResult = { kind: 'offline' };

// ---- State ----

let entries = new Map<string, PendingRetitle>();
let loading: Promise<void> | null = null;
let idSnapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

/**
 * Attempts running right now, by issue. A flush skips an issue in here, so the
 * immediate attempt from the New issue screen and a flush kicked off by the sync
 * that same save triggers never both ask — and both bill — for one title.
 *
 * Registered synchronously, before the first await of an attempt, which is what
 * makes {@link isRetitlePending} true from the instant `retitleIssue` is called —
 * earlier than the entry itself, which only exists once the queue has persisted.
 */
const inFlight = new Map<string, Promise<AttemptResult>>();

/**
 * Serializes read-modify-write of the stored queue across every tab, and
 * re-reads it before each one (see github-outbox, which explains both halves).
 */
const runSerialized = serializedPerProfile(STORAGE_KEY);

/** Whether the stored queue could be read; `persist` stays quiet when not. */
let storageKnown = true;

function serialize<T>(op: () => Promise<T>): Promise<T> {
  return runSerialized(async () => {
    await reconcile();
    return op();
  });
}

/** The entries in a stored blob, ignoring anything malformed or long expired. */
function parseStored(raw: string | null): PendingRetitle[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as Partial<StoredQueue>;
  if (!parsed || !Array.isArray(parsed.entries)) return [];
  const now = Date.now();
  const out: PendingRetitle[] = [];
  for (const e of parsed.entries) {
    if (!e || typeof e.issueId !== 'string' || typeof e.stub !== 'string') continue;
    if (typeof e.queuedAt !== 'number' || now - e.queuedAt > MAX_AGE_MS) continue;
    out.push({
      issueId: e.issueId,
      stub: e.stub,
      identity: typeof e.identity === 'string' ? e.identity : '',
      queuedAt: e.queuedAt,
      attempts: typeof e.attempts === 'number' ? e.attempts : 0,
    });
  }
  return out;
}

/** Bring this tab's map up to date with the stored queue. See github-outbox. */
async function reconcile(): Promise<void> {
  let stored: PendingRetitle[];
  try {
    stored = parseStored(await db.getSetting(STORAGE_KEY));
    storageKnown = true;
  } catch (e) {
    storageKnown = false;
    if (!isDbLockedError(e)) {
      Sentry.captureException(e, { tags: { source: 'issue-retitle', op: 'load' } });
    }
    return;
  }

  const before = entries.size;
  let changed = false;
  const seen = new Set<string>();
  for (const entry of stored) {
    seen.add(entry.issueId);
    const live = entries.get(entry.issueId);
    if (live) Object.assign(live, entry);
    else {
      entries.set(entry.issueId, entry);
      changed = true;
    }
  }
  for (const id of [...entries.keys()]) {
    // An attempt running here owns its entry until it settles; another tab's
    // blob is simply older than this one's in-flight work.
    if (!seen.has(id) && !inFlight.has(id)) entries.delete(id);
  }
  if (changed || entries.size !== before) refreshSnapshot();
}

function refreshSnapshot(): void {
  idSnapshot = new Set(entries.keys());
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      Sentry.captureException(e, { tags: { source: 'issue-retitle', op: 'emit' } });
    }
  }
}

export function subscribeIssueRetitles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Local issue ids still waiting on a title. Stable reference between changes. */
export function pendingRetitleIssueIds(): ReadonlySet<string> {
  return idSnapshot;
}

/** Whether this issue is waiting on a title or has a request out for one now. */
export function isRetitlePending(issueId: string): boolean {
  return entries.has(issueId) || inFlight.has(issueId);
}

// ---- Persistence ----

async function persist(): Promise<void> {
  if (!storageKnown) return;
  const payload: StoredQueue = { v: 1, entries: [...entries.values()] };
  try {
    await db.setSetting(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    if (isDbLockedError(e)) return;
    Sentry.captureException(e, { tags: { source: 'issue-retitle', op: 'persist' } });
  }
}

/** Hydrate the queue from the device. Safe to call more than once. */
export function loadIssueRetitles(): Promise<void> {
  loading ??= reloadIssueRetitles();
  return loading;
}

/** Re-read the durable queue now — another tab may have changed it. */
export function reloadIssueRetitles(): Promise<void> {
  return serialize(async () => {});
}

/** Drop everything — the local issues were wiped (sign-out, account switch). */
export async function clearIssueRetitles(): Promise<void> {
  await serialize(async () => {
    entries = new Map();
    refreshSnapshot();
    await persist();
  });
}

/**
 * Re-stamp entries onto the account an anonymous device just claimed its data
 * into. Hydrates first, outside `serialize`, for the reason `reassignGithubOutbox`
 * spells out.
 */
export async function reassignIssueRetitles(identity: string): Promise<void> {
  await loadIssueRetitles();
  await serialize(async () => {
    if (entries.size === 0) return;
    for (const e of entries.values()) e.identity = identity;
    await persist();
  });
}

/**
 * Stop titling this issue — someone opened it to edit, so the title is theirs.
 *
 * Needed beyond the stand-in lock because the edit sheet reseeds its fields
 * whenever the issue changes: a model title landing mid-edit would replace what
 * they were typing. A request already out finds its entry gone and applies
 * nothing.
 */
export async function cancelIssueRetitle(issueId: string): Promise<void> {
  await drop(issueId, 'opened for editing');
}

// ---- Queue ----

/**
 * Whether a failed title request is worth asking again later.
 *
 * Transport failures and 5xx/429 are: the server or the model was unreachable or
 * busy. So is 404 — the app can ship before the backend that serves this route,
 * and an issue created in that gap should still get its title once it lands.
 * Every other status is an answer that won't change — 402 (no key, or a key
 * Anthropic rejected), 413, 422 (refused), 400.
 */
export function isRetryableTitleError(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 404 || e.status === 429 || e.status >= 500;
  if (e instanceof AuthUnavailableError) return true;
  if (e instanceof Error && e.message.includes('EXPO_PUBLIC_API_URL')) return false;
  return true;
}

async function enqueue(issueId: string, stub: string): Promise<PendingRetitle> {
  return serialize(async () => {
    const existing = entries.get(issueId);
    if (existing) return existing;
    const identity = (await db.getSetting(SYNCED_UID).catch(() => '')) ?? '';
    const entry: PendingRetitle = { issueId, stub, identity, queuedAt: Date.now(), attempts: 0 };
    entries.set(issueId, entry);
    if (entries.size > MAX_ENTRIES) {
      const oldest = [...entries.values()].sort((a, b) => a.queuedAt - b.queuedAt);
      for (const e of oldest.slice(0, entries.size - MAX_ENTRIES)) entries.delete(e.issueId);
    }
    refreshSnapshot();
    await persist();
    return entry;
  });
}

async function drop(issueId: string, why: string): Promise<void> {
  await serialize(async () => {
    if (!entries.delete(issueId)) return;
    Sentry.addBreadcrumb({ category: 'issue-retitle', message: `dropped ${issueId}: ${why}`, level: 'info' });
    refreshSnapshot();
    await persist();
  });
}

async function bumpAttempts(entry: PendingRetitle): Promise<void> {
  await serialize(async () => {
    const live = entries.get(entry.issueId);
    if (!live) return;
    live.attempts += 1;
    entry.attempts = live.attempts;
    await persist();
  });
}

/** Register a running attempt; it unregisters itself when it settles. */
function track(issueId: string, run: Promise<AttemptResult>): Promise<AttemptResult> {
  inFlight.set(issueId, run);
  const release = () => {
    if (inFlight.get(issueId) === run) inFlight.delete(issueId);
  };
  run.then(release, release);
  return run;
}

/** What to check this issue against; never throws, and never blocks titling. */
async function gatherCandidates(
  issueId: string,
  text: string,
  deps: RetitleDeps,
): Promise<DuplicateCandidate[]> {
  if (!deps.candidates) return [];
  try {
    return await deps.candidates(issueId, text);
  } catch (e) {
    if (!isDbLockedError(e)) {
      Sentry.captureException(e, { tags: { source: 'issue-retitle', op: 'candidates' } });
    }
    return [];
  }
}

/**
 * One request for one entry.
 *
 * `knownText` is the immediate path: the text comes from the screen that just
 * created the issue, so there is nothing to read back first.
 */
async function attemptOnce(
  entry: PendingRetitle,
  deps: RetitleDeps,
  knownText?: string,
): Promise<AttemptResult> {
  let text = knownText;
  if (text === undefined) {
    const row = await db.getIssueById(entry.issueId);
    if (!row) {
      await drop(entry.issueId, 'issue no longer exists');
      return KEPT;
    }
    // Trashed but restorable: hold rather than drop; the TTL is the backstop.
    if (row.deletedAt != null) return HELD;
    // Not just a shortcut: the conditional write would refuse this anyway, but
    // only after a request someone paid for.
    if (row.title !== entry.stub) {
      await drop(entry.issueId, 'renamed by hand');
      return KEPT;
    }
    text = row.description;
  }
  if (!text.trim()) {
    await drop(entry.issueId, 'nothing to name');
    return KEPT;
  }

  const candidates = await gatherCandidates(entry.issueId, text, deps);
  await bumpAttempts(entry);
  let title: string;
  let duplicateOf: string | null;
  try {
    ({ title, duplicateOf } = await requestIssueTitle(text, candidates));
  } catch (e) {
    if (isRetryableTitleError(e) && entry.attempts < MAX_ATTEMPTS) return OFFLINE;
    // 402 is the everyday case for an account with no key — not an error.
    if (!(e instanceof ApiError && e.status === 402)) {
      Sentry.captureException(e, {
        tags: { source: 'issue-retitle', op: 'request', attempts: String(entry.attempts) },
      });
    }
    await drop(entry.issueId, 'gave up; keeping the stand-in');
    return KEPT;
  }

  // Cancelled (opened for editing) or cleared (sign-out) while the model wrote.
  if (!entries.has(entry.issueId)) return KEPT;
  // Before the title — see "DUPLICATES RIDE ALONG" above. Only an id that was
  // actually offered counts; the server checks that too.
  if (duplicateOf && deps.applyDuplicate && candidates.some((c) => c.id === duplicateOf)) {
    try {
      await deps.applyDuplicate(entry.issueId, duplicateOf);
    } catch (e) {
      Sentry.captureException(e, { tags: { source: 'issue-retitle', op: 'apply-duplicate' } });
    }
  }
  if (!(await deps.applyTitle(entry.issueId, entry.stub, title))) {
    await drop(entry.issueId, 'renamed or trashed while titling');
    return KEPT;
  }
  try {
    await deps.onRetitled?.(entry.issueId, title);
  } catch (e) {
    Sentry.captureException(e, { tags: { source: 'issue-retitle', op: 'on-retitled' } });
  }
  await drop(entry.issueId, 'titled');
  return { kind: 'titled', title };
}

/**
 * Title a just-created issue: queue the intent durably, then try once right away.
 *
 * Never rejects. A caller chains its GitHub push onto this, and a throw here
 * would silently skip that push.
 */
export async function retitleIssue(
  params: { issueId: string; stub: string; text: string },
  deps: RetitleDeps,
): Promise<RetitleOutcome> {
  const { issueId, stub, text } = params;
  // Tracked before the first await, so `isRetitlePending` holds from this call on.
  const run = track(
    issueId,
    (async () => {
      await loadIssueRetitles();
      const entry = await enqueue(issueId, stub);
      return attemptOnce(entry, deps, text);
    })(),
  );
  try {
    const result = await run;
    if (result.kind === 'titled') return { status: 'titled', title: result.title };
    return result.kind === 'kept' ? { status: 'kept' } : { status: 'queued' };
  } catch (e) {
    if (!isDbLockedError(e)) {
      Sentry.captureException(e, { tags: { source: 'issue-retitle', op: 'retitle' } });
    }
    return { status: 'queued' };
  }
}

export type RetitleFlushResult = { titled: number; dropped: number; remaining: number };

let flushing: Promise<RetitleFlushResult> | null = null;

/**
 * Retry every waiting title. Concurrent calls share one run, and the run stops
 * at the first request that couldn't get through — the rest would fail the same
 * way.
 */
export function flushIssueRetitles(deps: RetitleDeps): Promise<RetitleFlushResult> {
  if (flushing) return flushing;
  flushing = runFlush(deps).finally(() => {
    flushing = null;
  });
  return flushing;
}

async function runFlush(deps: RetitleDeps): Promise<RetitleFlushResult> {
  // Read the durable queue first: titles queued in another tab are this tab's
  // to retry, and `remaining` should describe the queue rather than this realm.
  await reloadIssueRetitles();

  // Owner tab only, for the same reason as the GitHub outbox: `flushing` above
  // dedupes within one realm, and a retitle is a model call billed to the
  // user's own key. Two tabs replaying the queue would pay for every title
  // twice and then race to write the winner.
  if (!(await ownsBackgroundWork())) return { titled: 0, dropped: 0, remaining: entries.size };

  let titled = 0;
  let dropped = 0;
  if (entries.size === 0) return { titled, dropped, remaining: 0 };

  const identity = (await db.getSetting(SYNCED_UID).catch(() => '')) ?? '';

  for (const snapshot of [...entries.values()]) {
    const entry = entries.get(snapshot.issueId);
    if (!entry) continue;
    // Someone else's attempt owns it right now.
    if (inFlight.has(entry.issueId)) continue;
    // Queued under another account: that account's key, not this one's. Skipped
    // rather than dropped. A real account switch clears the queue outright; a
    // mismatch that reaches here is the claim racing this flush — the identity
    // read above predates `reassignIssueRetitles` — and dropping would throw away
    // titles the claim is about to make this account's. The TTL is the backstop.
    if (entry.identity !== identity) continue;
    if (Date.now() - entry.queuedAt > MAX_AGE_MS) {
      await drop(entry.issueId, 'expired');
      dropped += 1;
      continue;
    }
    let result: AttemptResult;
    try {
      result = await track(entry.issueId, attemptOnce(entry, deps));
    } catch (e) {
      if (isDbLockedError(e)) break; // follower tab; the owning tab will flush
      throw e;
    }
    if (result.kind === 'offline') break;
    if (result.kind === 'titled') titled += 1;
    else if (result.kind === 'kept') dropped += 1;
  }

  return { titled, dropped, remaining: entries.size };
}
