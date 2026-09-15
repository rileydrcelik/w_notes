/**
 * Identity and liveness for one page session (web).
 *
 * A `blob:` URL only resolves inside the document that created it. That is why
 * `clearEphemeralFilePaths` in `db.ts` nulls them on open — after a reload the
 * URL is a dead pointer and keeping it would strand the row on bytes no one can
 * read.
 *
 * But "dead" is a property of the *creating document*, not of the database. With
 * more than one tab open — a handover, or genuinely concurrent tabs — one page's
 * open would otherwise null a `blob:` URL another page is still holding, and for
 * an attachment that has not finished uploading (`remote_key` still NULL) those
 * bytes exist nowhere else. The row survives with no file and no way to fetch
 * one, silently.
 *
 * So a page stamps the rows it creates, and a clear only touches rows whose
 * session is provably gone. Liveness rides the Web Locks API rather than a
 * heartbeat: a lock is released by the browser when the page goes, including on
 * a crash or a discard, which is exactly the signal wanted and one no timer can
 * report as reliably.
 */

const SESSION_LOCK_PREFIX = 'wnotes-session-';

/** This page's id. Stable for the document's lifetime, unique across tabs. */
const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

let holding: Promise<boolean> | null = null;

/**
 * Take this session's lock and never release it. Resolves to whether the lock is
 * actually held, so a caller about to read the live set can be sure this page is
 * in it — otherwise a page could clear its own freshly written rows.
 *
 * It must resolve even when the request fails. `request` rejects on an opaque
 * origin (a sandboxed iframe, a `data:` document) and when the document isn't
 * fully active, and `navigator.locks` is still *defined* in both — so the guard
 * above doesn't cover them. Left pending, this promise is memoised, awaited by
 * `liveSessionIds`, and awaited in turn by the database open, which would hang
 * on a connection that never resolves or rejects: no error, no Sentry, an empty
 * app forever. `false` routes to the honest "can't tell" answer instead.
 */
function holdSessionLock(): Promise<boolean> {
  if (holding) return holding;
  holding = new Promise<boolean>((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      resolve(false);
      return;
    }
    navigator.locks
      .request(`${SESSION_LOCK_PREFIX}${id}`, async () => {
        resolve(true);
        // Held for the page's lifetime; the browser releases it when we go.
        await new Promise<void>(() => {});
      })
      .catch(() => resolve(false));
  });
  return holding;
}

/** The session that owns local file paths written by this page. */
export function pageSessionId(): string {
  return id;
}

/**
 * The sessions currently alive in this browser, or `null` when that can't be
 * determined — on a browser with no Web Locks, where there is no way to tell a
 * live page from a dead one. `null` means "fall back to clearing everything",
 * which is the behaviour that shipped before this existed: it can still strand
 * an in-flight attachment, but only where we are blind anyway, and it never
 * leaves a dead URL behind.
 */
export async function liveSessionIds(): Promise<Set<string> | null> {
  if (typeof navigator === 'undefined' || !navigator.locks?.query) return null;
  // Without our own lock held there is no honest answer: a query that omitted
  // this page would have it clear the rows it just wrote.
  if (!(await holdSessionLock())) return null;
  // `query` can reject too, and this runs inside the database open — which had
  // no failure mode here before. Unknown beats throwing out through `open`.
  const held = await navigator.locks
    .query()
    .then((state) => state.held)
    .catch(() => null);
  if (!held) return null;
  // Seeded with this page, which is alive by construction — we hold its lock.
  // Trusting `query` alone to say so would stake an un-uploaded attachment on
  // it reporting our own lock back, and the caller reads an empty set as
  // "clear everything".
  const ids = new Set<string>([id]);
  for (const lock of held ?? []) {
    const name = lock.name ?? '';
    if (name.startsWith(SESSION_LOCK_PREFIX)) ids.add(name.slice(SESSION_LOCK_PREFIX.length));
  }
  return ids;
}
