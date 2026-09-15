/**
 * The seam every database call passes through (web), and the transport that
 * carries a non-owning tab's calls to the tab that owns the connection.
 *
 * On web, SQLite runs through wa-sqlite's OPFS `AccessHandlePoolVFS`, which
 * takes an exclusive OS-level lock on the database directory — so exactly one
 * tab can hold the connection, and `db.ts` gates its open on owning it
 * (`whenDbOwner`). A tab that isn't the owner must never touch the file: a
 * failed open wedges wa-sqlite's VFS for the whole page, permanently. So the
 * other tabs don't open anything; they ask the owner.
 *
 * It carries whole `db` methods rather than the SQL underneath them, and that
 * distinction is the design. Every mutating method already runs through one
 * promise chain (`serializeWrite` in `db.ts`) so two writes can't interleave
 * their transactions — the bug behind "can't delete trash". That chain is
 * per-JavaScript-realm. Shipping statements would leave each tab with its own
 * chain while they shared one connection, letting two tabs' BEGIN/COMMIT
 * interleave, and `withExclusiveTransactionAsync` throws on web so nothing
 * would catch it. Shipping methods puts every tab's writes on the owner's one
 * chain, where the guarantee still means what it says.
 *
 * Transport is `BroadcastChannel`, not a transferred `MessagePort`:
 * `BroadcastChannel.postMessage` takes no transfer list, so handing a port
 * across one throws. Requests go out on a shared channel; each caller listens
 * on a channel named after itself, so a reply — which may be the whole library
 * from `bootstrap()` — is cloned once for the tab that asked rather than once
 * per tab listening.
 */

import { isDbLeader, subscribeDbRole, whenRoleSettled } from '@/lib/web-db-lock';

/** The shape of the object being shared: async methods, as `db` exposes. */
type AsyncMethod = (...args: unknown[]) => Promise<unknown>;

const REQUEST_CHANNEL = 'wnotes-db-rpc';
/** Each caller's private reply channel, so a large result is cloned once. */
const replyChannel = (tab: string) => `${REQUEST_CHANNEL}:${tab}`;

/**
 * How long a call waits with no sign of life from an owner before giving up.
 * Generous: this is a liveness budget, not a latency one, and the owner may be
 * midway through a large write when the request lands.
 */
const CALL_TIMEOUT_MS = 30_000;

const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

type Request = { k: 'req'; id: number; from: string; method: string; args: unknown[] };
type Ack = { k: 'ack'; id: number };
type SerializedError = { name: string; message: string };
type Response = { k: 'res'; id: number; ok: boolean; value?: unknown; error?: SerializedError };

/** A call this tab has sent and is still waiting on. */
type Pending = {
  method: string;
  args: unknown[];
  /** Set once the owner says it has begun; after that the call can't be retried. */
  started: boolean;
  settle: (outcome: { ok: true; value: unknown } | { ok: false; error: Error }) => void;
  timer: ReturnType<typeof setTimeout>;
};

let requests: BroadcastChannel | null = null;
let replies: BroadcastChannel | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

/** The local API, registered by `shareDbAcrossTabs` so the owner can serve it. */
let served: Record<string, unknown> | null = null;

/**
 * An error carried across a channel. `name` survives because callers key off it
 * — `isDbLockedError` reads `name`/`message`, and Sentry groups on them — and a
 * structured clone of an `Error` subclass would not preserve it.
 */
function serializeError(e: unknown): SerializedError {
  const name = (e as { name?: string })?.name ?? 'Error';
  const message = String((e as { message?: string })?.message ?? e ?? '');
  return { name, message };
}

function reviveError({ name, message }: SerializedError): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** Thrown when the owner vanished mid-call and the outcome is unknowable. */
function ownerLostError(method: string): Error {
  const err = new Error(
    `the tab holding the database closed while ${method} was running; it may or may not have been applied`,
  );
  err.name = 'DbOwnerLost';
  return err;
}

function ensureChannels(): void {
  if (requests || typeof BroadcastChannel === 'undefined') return;

  requests = new BroadcastChannel(REQUEST_CHANNEL);
  requests.onmessage = (e: MessageEvent<Request>) => {
    const msg = e.data;
    if (msg?.k !== 'req') return;
    // Only the owner answers, and only it can: everyone else has no connection.
    if (!isDbLeader() || !served) return;
    void serve(msg);
  };

  replies = new BroadcastChannel(replyChannel(tabId));
  replies.onmessage = (e: MessageEvent<Ack | Response>) => {
    const msg = e.data;
    if (msg?.k === 'ack') {
      const call = pending.get(msg.id);
      if (call) call.started = true;
      return;
    }
    if (msg?.k !== 'res') return;
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    clearTimeout(call.timer);
    call.settle(
      msg.ok
        ? { ok: true, value: msg.value }
        : { ok: false, error: reviveError(msg.error ?? { name: 'Error', message: 'failed' }) },
    );
  };

  // A tab that gains the connection can no longer be waiting on someone else's.
  subscribeDbRole((role) => {
    if (role === 'leader') adoptPendingCalls();
  });
}

/** Run one request against the local database and answer the caller. */
async function serve(msg: Request): Promise<void> {
  const back = new BroadcastChannel(replyChannel(msg.from));
  try {
    const method = served?.[msg.method];
    if (typeof method !== 'function') {
      const error = serializeError(new Error(`unknown database method ${msg.method}`));
      back.postMessage({ k: 'res', id: msg.id, ok: false, error } satisfies Response);
      return;
    }
    // Tell the caller the work has begun *before* doing it. That is what lets a
    // caller tell a call that never started — safe to re-run once this tab owns
    // the database — from one that may already have written.
    back.postMessage({ k: 'ack', id: msg.id } satisfies Ack);
    try {
      const value = await (method as AsyncMethod)(...msg.args);
      back.postMessage({ k: 'res', id: msg.id, ok: true, value } satisfies Response);
    } catch (e) {
      back.postMessage({
        k: 'res',
        id: msg.id,
        ok: false,
        error: serializeError(e),
      } satisfies Response);
    }
  } finally {
    back.close();
  }
}

/**
 * This tab just became the owner. Calls that were never acknowledged can't have
 * run anywhere, so re-issue them locally; calls already under way somewhere else
 * have an unknown outcome and are surfaced rather than repeated — `createNote`
 * would collide on its primary key and `restoreFromTrash` isn't idempotent, so a
 * blind retry trades a reported failure for a silently wrong answer.
 */
function adoptPendingCalls(): void {
  for (const [id, call] of [...pending]) {
    pending.delete(id);
    clearTimeout(call.timer);
    const method = served?.[call.method];
    if (call.started || typeof method !== 'function') {
      call.settle({ ok: false, error: ownerLostError(call.method) });
      continue;
    }
    void (method as AsyncMethod)(...call.args).then(
      (value) => call.settle({ ok: true, value }),
      (error: unknown) => call.settle({ ok: false, error: error as Error }),
    );
  }
}

/** Send one call to the owning tab and wait for its answer. */
function callOwner(method: string, args: unknown[]): Promise<unknown> {
  ensureChannels();
  if (!requests) {
    // No BroadcastChannel: nothing can be routed, and this tab has no
    // connection of its own. Failing is honest; the guard renders over it.
    return Promise.reject(ownerLostError(method));
  }
  const id = nextId++;
  return new Promise<unknown>((resolve, reject) => {
    const settle: Pending['settle'] = (outcome) =>
      outcome.ok ? resolve(outcome.value) : reject(outcome.error);
    const timer = setTimeout(() => {
      pending.delete(id);
      settle({ ok: false, error: ownerLostError(method) });
    }, CALL_TIMEOUT_MS);
    pending.set(id, { method, args, started: false, settle, timer });
    requests?.postMessage({ k: 'req', id, from: tabId, method, args } satisfies Request);
  });
}

/**
 * Wrap a database API so its calls are routed per call rather than per object.
 *
 * Built eagerly, one dispatching function per key, instead of with a `Proxy`:
 * the identity of the returned object and its methods is then stable for the
 * program's life, which matters because ownership changes while the app is
 * running and callers hold onto `db` indefinitely. Deciding where a call goes
 * *inside* the dispatcher is what lets a tab be promoted without anything
 * re-importing.
 *
 * Every call waits for the role to be known first. Election resolves in a later
 * task, so a tab reading the default would decide it was a follower during its
 * own first moments — including the tab about to become the owner, whose calls
 * would then be addressed to nobody.
 */
export function shareDbAcrossTabs<T extends object>(api: T): T {
  const source = api as Record<string, unknown>;
  served = source;
  // Listen from the moment the API exists, not from this tab's first call: the
  // owner has to be able to answer a follower that asks before it has asked
  // anything itself. This also starts election, via `subscribeDbRole`.
  ensureChannels();
  const shared: Record<string, unknown> = {};
  for (const name of Object.keys(source)) {
    const value = source[name];
    if (typeof value !== 'function') {
      shared[name] = value;
      continue;
    }
    shared[name] = async (...args: unknown[]) => {
      ensureChannels();
      await whenRoleSettled();
      // Looked up per call, not captured, so replacing a method on the source
      // object after wrapping (as `serializeWrite` does) is still honoured.
      if (isDbLeader()) return (source[name] as AsyncMethod)(...args);
      return callOwner(name, args);
    };
  }
  return shared as T;
}
