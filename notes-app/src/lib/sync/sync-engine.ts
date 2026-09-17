/**
 * Sync engine — delta sync against the backend, keyed on the device key.
 *
 * A pass is: push every locally-dirty row, then pull everything the server has
 * changed since our cursor and apply it last-writer-wins. Conflict resolution
 * lives in the DB layer (`applyServerRows`); this module orchestrates the round
 * trip, the cursor, concurrency, and notifying the stores when data changed.
 *
 * Identity is still the anonymous device key this pass — enough to back up and
 * round-trip a single device. Real cross-device sync arrives with auth (a shared
 * account identity); the engine itself won't change, only how the bearer token
 * is obtained.
 */
import { Sentry } from '@/lib/sentry';
import { db, type SyncPayload } from '@/lib/db';
import { isDbLockedError } from '@/lib/web-db-lock';
import { runInDbOwner } from '@/lib/db-tabs';
import { AuthUnavailableError } from '@/lib/auth/token';
import { clearGithubOutbox, reassignGithubOutbox } from '@/lib/github-outbox';
import { clearIssueRetitles, reassignIssueRetitles } from '@/lib/issue-retitle';
import {
  holdGithubDraftsForAccountChange,
  reassignGithubDrafts,
} from '@/lib/github-issue-drafts';
import { ApiError, apiFetch, syncConfigured } from './api';
import { getDeviceKey, rotateDeviceKey } from './device-key';
import { downloadCopaFile, prepareLocalFiles, uploadCopaFile } from './files';

const SYNCED_UID = 'synced_uid';

type PullResponse = SyncPayload & { server_seq: number; has_more?: boolean };

/**
 * How long a tab waits for the owner to finish a pass or an account transition.
 *
 * Far more than an ordinary database call gets, because these talk to the
 * network: the default 30s would give up on a slow first sync that is working
 * perfectly and raise the "can't reach your notes" guard over it.
 */
const OWNER_CALL_TIMEOUT_MS = 120_000;

/**
 * Serializes account transitions against each other.
 *
 * Every tab hears the Firebase auth change and asks the owner to handle it, so
 * the owner can be asked two or three times at once. Overlapping runs would
 * each read `synced_uid` before either wrote it, and both would take the
 * first-account branch — claiming, wiping and re-cursoring twice over.
 */
let accountTail: Promise<unknown> = Promise.resolve();

function serializeAccountOp<T>(op: () => Promise<T>): Promise<T> {
  const run = accountTail.then(op, op);
  accountTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Whose data a pass is for; '' while anonymous. */
async function currentIdentity(fallback = ''): Promise<string> {
  return (await db.getSetting(SYNCED_UID).catch(() => fallback)) ?? '';
}

/**
 * A pass whose account changed underneath it. Its results describe the old
 * identity, so its bookkeeping must not be written — see the guards below.
 */
const ACCOUNT_CHANGED: SyncResult = { status: 'skipped', reason: 'account changed mid-pass' };

// Safety stop for the pull loop. Each page strictly advances the cursor, so this
// can only be reached by a genuinely enormous backlog — in which case we stop,
// keep what we applied, and let the next pass carry on from the saved cursor
// rather than spinning here.
const MAX_PULL_PAGES = 50;

export type SyncResult =
  | { status: 'ok'; cursor: number; pushed: number; pulled: number }
  | { status: 'skipped'; reason: string };

// ---- "data changed" subscription, so stores can refresh after a pull ----

const listeners = new Set<() => void>();

/** Subscribe to "sync applied remote changes"; returns an unsubscribe fn. */
export function subscribeSynced(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Listeners for "a sync pass completed against the server" — the app's own online
 * signal. Separate from `listeners` above, which fire only when a pull actually
 * changed something: a device that is merely reachable changes nothing, and that
 * is precisely the case a held-back GitHub push is waiting for.
 */
const successListeners = new Set<() => void>();

/**
 * Subscribe to "a sync pass reached the server and came back ok"; returns an
 * unsubscribe fn.
 *
 * This is the signal to retry anything that was held back while offline (see
 * lib/github-outbox.ts). It is deliberately not a network-reachability check: a
 * request to the GitHub proxy needs the same BASE_URL, the same bearer and the
 * same CORS story as sync itself, so a completed pass proves exactly the right
 * preconditions. "Wi-Fi is up" proves none of them — a captive portal reports a
 * healthy connection and fails every request behind it.
 *
 * Only a `status: "ok"` pass emits. A `skipped` one must not: it covers the
 * follower browser tab that cannot hold the database, and the account whose
 * auth session has not been restored yet — neither can push anything.
 */
export function subscribeSyncSuccess(listener: () => void): () => void {
  successListeners.add(listener);
  return () => successListeners.delete(listener);
}

function emitSyncSuccess(): void {
  for (const l of successListeners) {
    try {
      l();
    } catch (e) {
      Sentry.captureException(e, { tags: { source: 'sync-engine', op: 'emit-success' } });
    }
  }
}

function emitSynced(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      Sentry.captureException(e, { tags: { source: 'sync-engine', op: 'emit' } });
    }
  }
}

/**
 * Tell every data store to re-read from the local database. Used when this tab
 * takes ownership of the web DB (a promoted follower tab, see web-db-lock.ts) so
 * its content appears without a page reload; sync itself emits this after a pull.
 */
export function refreshFromDb(): void {
  emitSynced();
}

/**
 * Called when this tab has just taken ownership of the web database (a promoted
 * follower — see web-db-lock.ts). Because the DB layer gates opens on ownership
 * (whenDbOwner), the OPFS file was never touched while we were a follower, so
 * this open starts from a clean VFS and succeeds in place. Then tell every store
 * (and the theme) to hydrate from it — filling the UI without a page reload.
 */
export async function reopenDbAndRefresh(): Promise<void> {
  try {
    await db.ensureOpen();
  } catch (e) {
    Sentry.captureException(e, { tags: { source: 'sync-engine', op: 'reopen' } });
  }
  refreshFromDb();
}

// ---- Core pass (deduped so overlapping triggers share one in-flight run) ----

let inflight: Promise<SyncResult> | null = null;

/**
 * When sync last carried real data in either direction (epoch ms, 0 = never).
 * The poll uses it to run tight while a device is part of a live conversation
 * — the user editing here, or another device's edits landing — and to fall back
 * to a lazy interval once everything has been quiet for a while.
 */
let lastActivityAt = 0;

function markActivity(): void {
  lastActivityAt = Date.now();
}

/** How long since sync last moved data (Infinity if it never has this session). */
export function msSinceSyncActivity(): number {
  return lastActivityAt === 0 ? Infinity : Date.now() - lastActivityAt;
}

// One-time per-session reconciliation of local file paths (see prepareLocalFiles).
let filesPrepared = false;

/**
 * Runs one sync pass. Safe to call from anywhere and as often as you like:
 * concurrent calls return the same in-flight promise, and it no-ops cleanly when
 * sync isn't configured.
 */
function syncNowHere(): Promise<SyncResult> {
  if (inflight) return inflight;
  inflight = runSync().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * One pass per browser profile, not per tab — so it runs in the tab that owns
 * the database, wherever it was asked for.
 *
 * `inflight` above dedupes within a realm, which was the whole story while only
 * one tab could reach the database. Now that any tab can, each would run its own
 * pass; they would collide on the backend's per-user advisory lock, where the
 * loser waits out `lock_timeout` holding a connection from a small pool — the
 * outage in docs/HANDOFF-2026-09-15-sync-wedge.md, as a steady state.
 *
 * Routed rather than skipped, which is the distinction that matters: a tab that
 * quietly reported "skipped" still looked like a tab that had synced. Sign-out
 * believed it and wiped the database behind a flush that never ran, and a
 * follower's edits waited on the owner's next poll — up to a minute, or forever
 * while the owner sat throttled in the background.
 */
export const syncNow = runInDbOwner('sync:now', syncNowHere, {
  timeoutMs: OWNER_CALL_TIMEOUT_MS,
});

async function runSync(): Promise<SyncResult> {
  if (!syncConfigured) {
    return { status: 'skipped', reason: 'EXPO_PUBLIC_API_URL not set' };
  }

  try {
    // Ensure the device key exists + is persisted before the first request.
    await getDeviceKey();

    // Whose data this pass is for, read once up front and re-checked before
    // each piece of bookkeeping below. An account transition can land between
    // this pass's requests and its writes — it runs in this same tab now, but
    // any tab can start it — and the results belong to the identity the pass
    // began under. Saving them afterwards is how a cursor earned under the
    // anonymous device key gets stored as the account's, after which every
    // older row of that account is silently never pulled again.
    const identity = await currentIdentity();

    // Once per session, reconcile local file paths before any file pass. Both
    // platforms no-op today: clearing web's dead object URLs moved into the
    // database open, which is the only point ahead of the stores hydrating. The
    // hook stays as the seam for any future per-session file reconciliation.
    if (!filesPrepared) {
      await prepareLocalFiles();
      filesPrepared = true;
    }

    // 0) Upload bytes for any file blocks not yet in S3, stamping each row with
    //    its remote_key so the push below carries it across to other devices.
    await uploadPendingFiles();

    // 1) Push local changes. The server takes them last-writer-wins; on success
    //    we clear the dirty flags for exactly what we sent.
    const dirty = await db.getDirty();
    // Counted across whatever tables the payload holds, rather than by naming
    // each one. This used to be a hand-written sum, and a table left out of it
    // was the worst kind of bug available here: a sync pass carrying *only* rows
    // from the forgotten table computes zero, skips the push entirely, and
    // strands those rows dirty for ever with no error anywhere. Every field of
    // `SyncPayload` is an array of rows, so this cannot fall behind the schema.
    const pushed = Object.values(dirty).reduce((total, rows) => total + rows.length, 0);
    if (pushed > 0) {
      await apiFetch('/sync/push', { method: 'POST', body: dirty });
      // Clearing `dirty` for rows pushed under the previous account would strip
      // the flags a claim just set, so those rows would never reach the new one.
      if ((await currentIdentity(identity)) !== identity) return ACCOUNT_CHANGED;
      await db.markSynced(dirty);
    }

    // 2) Pull everything changed since our cursor and apply it locally. The
    //    server answers in bounded pages; drain them, saving the cursor after
    //    each one. Persisting per page is the point — a first sync that dies
    //    halfway now resumes from where it got to instead of restarting, which
    //    is what made a big backlog unsyncable: the whole thing had to land in a
    //    single response or none of it counted.
    let cursor = await db.getCursor();
    let changed = 0;
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const pulled = await apiFetch<PullResponse>(`/sync/pull?since=${cursor}`);
      if ((await currentIdentity(identity)) !== identity) return ACCOUNT_CHANGED;
      changed += await db.applyServerRows(pulled);
      await db.setCursor(pulled.server_seq);
      // Defend the loop rather than trust the server: a cursor that fails to
      // advance would otherwise re-request the same page for ever.
      const advanced = pulled.server_seq > cursor;
      cursor = pulled.server_seq;
      if (!pulled.has_more || !advanced) break;
    }

    // 3) Download bytes for any file blocks we now know about but don't hold
    //    locally yet (e.g. created on another device).
    const downloaded = await downloadMissingFiles();

    if (changed > 0 || downloaded > 0) emitSynced();
    // Anything moving in either direction means this device is mid-conversation
    // with another one; keep the poll tight (see poll.ts).
    if (pushed > 0 || changed > 0 || downloaded > 0) markActivity();
    // The pass reached the server and came back: tell anything that was waiting
    // on connectivity to retry (see subscribeSyncSuccess).
    emitSyncSuccess();
    return { status: 'ok', cursor, pushed, pulled: changed };
  } catch (e) {
    // 501 = endpoints not wired (shouldn't happen now, but stays graceful).
    if (e instanceof ApiError && e.status === 501) {
      return { status: 'skipped', reason: 'sync endpoints not implemented' };
    }
    // The account's Firebase session isn't available yet (restoring on launch,
    // or dropped). Defer rather than fork the account's data onto the device key.
    if (e instanceof AuthUnavailableError) {
      return { status: 'skipped', reason: 'auth session unavailable' };
    }
    // A follower browser tab can't reach the OPFS database (another tab owns it);
    // the DbTabGuard handles that, so skip rather than report it as an error.
    if (isDbLockedError(e)) {
      return { status: 'skipped', reason: 'database owned by another tab' };
    }
    // apiFetch already reports ApiError, so re-capturing it here would double up.
    // Everything else reaching this point came from the *local* half of the sync
    // cycle — SQLite, file I/O, the device key — and is reported nowhere else, so
    // it must still be captured. (Dropping this entirely would silence exactly the
    // kind of SQLite failure that once looked like "can't delete trash".)
    if (!(e instanceof ApiError)) {
      Sentry.captureException(e, { tags: { source: 'sync-engine' } });
    }
    throw e;
  }
}

/**
 * Uploads bytes for every file block that isn't in S3 yet, recording the
 * returned object key on the row (which re-queues it to push). Each file is
 * best-effort: a failure is logged and left pending for the next pass.
 */
async function uploadPendingFiles(): Promise<void> {
  const uploads = await db.getCopaUploads();
  for (const u of uploads) {
    try {
      const key = await uploadCopaFile(u.fileUri, u.mimeType);
      await db.setCopaRemoteKey(u.id, key);
    } catch (e) {
      console.warn('[sync] file upload failed:', e);
      Sentry.captureException(e, { tags: { source: 'sync-engine', op: 'upload' } });
    }
  }
}

/**
 * Downloads bytes for every file block we know of (has a remote_key) but don't
 * hold locally. Returns how many landed, so the caller can refresh the UI.
 */
async function downloadMissingFiles(): Promise<number> {
  const downloads = await db.getCopaDownloads();
  let landed = 0;
  for (const d of downloads) {
    try {
      const { fileUri, thumbUri } = await downloadCopaFile(d);
      await db.setCopaLocalFile(d.id, fileUri, thumbUri);
      landed += 1;
    } catch (e) {
      console.warn('[sync] file download failed:', e);
      Sentry.captureException(e, { tags: { source: 'sync-engine', op: 'download' } });
    }
  }
  return landed;
}

// ---- Account transitions (merge on sign-in, clean swap on sign-out) ----
//
// The bearer the API client sends is determined by the auth layer (Firebase ID
// token when signed in, else device key). These two functions keep the *local*
// data consistent across that transition. The caller (auth context) must update
// the active user *before* invoking them so the sync runs under the right
// identity.

/**
 * Run when a Firebase user signs in. The first account on a device claims the
 * anonymous local notes (mark everything dirty so it re-pushes under the new
 * identity); a different account replaces the local data instead. Either way we
 * reset the pull cursor — we're a different server user now — then sync.
 */
async function applySignIn(uid: string): Promise<void> {
  const prev = await db.getSetting(SYNCED_UID);
  if (prev !== uid) {
    if (!prev) {
      await db.markAllDirty(); // claim anonymous data into this account
      // The held-back GitHub pushes are claimed along with the rows they name:
      // same device, same issues, so they are still this user's intent. They do
      // have to be re-stamped, or the flush would refuse them as another
      // account's (see github-outbox).
      await reassignGithubOutbox(uid);
      // Composed issues that never got out are this user's own words, typed on
      // this device; the claim makes them theirs under the new account too.
      await reassignGithubDrafts(uid);
      // Waiting AI titles likewise name claimed rows; re-stamp so the flush
      // doesn't refuse them as another account's.
      await reassignIssueRetitles(uid);
    } else {
      await db.clearAllData(); // switched accounts without a clean sign-out
      // Every queued push names a row that was just wiped, and would in any
      // case bill the wrong account's GitHub token.
      await clearGithubOutbox();
      // Same for waiting AI titles, which would bill the wrong Anthropic key.
      await clearIssueRetitles();
      // Not cleared. A queued push names a row that was just wiped, but a
      // composed issue *is* the text someone typed, and deleting it as a side
      // effect of switching accounts is the loss this queue exists to stop. It
      // can't be filed as whoever signs in next either — GitHub calls bill the
      // caller's own token — so it is held, marked, and left recoverable.
      await holdGithubDraftsForAccountChange();
    }
    await db.setCursor(0);
    await db.setSetting(SYNCED_UID, uid);
  }
  await syncNow().catch(() => {});
  emitSynced(); // refresh the UI even if the pull brought nothing
}

/**
 * Run when the user signs out: flush pending changes under the account, then
 * wipe the local copy and rotate to a fresh anonymous device key so the next
 * (anonymous) session is a clean, separate identity.
 */
async function applySignOut(): Promise<void> {
  await syncNow().catch(() => {});
  await db.clearAllData();
  // The issues these pushes referred to are gone by the user's own request, so
  // dropping them is not data loss — replaying them later would be.
  await clearGithubOutbox();
  await clearIssueRetitles();
  // Composed issues are not pointers, so the same reasoning doesn't reach them
  // (see the account switch above). Held rather than dropped.
  await holdGithubDraftsForAccountChange();
  await db.setCursor(0);
  await db.setSetting(SYNCED_UID, '');
  await rotateDeviceKey();
  emitSynced();
}

/**
 * Both transitions run in the tab that owns the database, whichever tab the
 * user actually clicked in.
 *
 * They are not background work that a tab may skip — they are the one sync pass
 * that is not optional, followed by a wipe. Gated instead of routed, signing out
 * of a second tab returned from `syncNow()` immediately without pushing
 * anything, then deleted every local row through the seam: an unpushed edit had
 * no server copy and no local one either. Signing *in* had the mirror problem —
 * the claim landed in the owner's database while the owner, still holding the
 * anonymous bearer, pushed the newly-claimed library to the wrong identity and
 * saved a cursor that hid the real account's history for good.
 *
 * Running them here also settles which Firebase session they use: the owner's
 * own, the one whose token its requests will carry.
 */
export const onSignIn = runInDbOwner(
  'sync:onSignIn',
  (uid: string) => serializeAccountOp(() => applySignIn(uid)),
  { timeoutMs: OWNER_CALL_TIMEOUT_MS },
);

export const onSignOut = runInDbOwner('sync:onSignOut', () => serializeAccountOp(applySignOut), {
  timeoutMs: OWNER_CALL_TIMEOUT_MS,
});

// ---- Debounced trigger for the write path ----

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 800;

/**
 * Fire-and-forget sync, coalesced so a burst of edits results in a single pass
 * shortly after the user stops typing. Errors are swallowed (already reported to
 * Sentry inside the pass) so callers in the optimistic write path stay simple.
 *
 * `delayMs` tunes the debounce: notes use the default (typing-friendly), while
 * near-instant surfaces like copa pass a short delay so a change reaches other
 * devices right away. A short delay (rather than 0) still coalesces bursts and
 * captures the trailing edit — syncNow() alone would drop an edit that lands
 * mid-pass, since concurrent calls return the same in-flight promise.
 */
export function requestSync(delayMs: number = DEBOUNCE_MS): void {
  // A local edit is activity in its own right: the other device is likely being
  // watched right now, and this one should stay tight for its reply.
  markActivity();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void syncNow().catch(() => {});
  }, delayMs);
}
