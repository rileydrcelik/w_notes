import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `liveSessionIds` decides whether a `blob:` file path is still resolvable, and
 * `clearEphemeralFilePaths` nulls every row it leaves out. A session wrongly
 * reported dead takes an attachment's only copy with it when the bytes haven't
 * uploaded yet, so these cases are about who ends up in that set.
 *
 * The module holds its lock for the page's lifetime, so each case re-imports it
 * fresh rather than sharing one session id across tests.
 */

type LockInfo = { name?: string };

/**
 * A `navigator.locks` stand-in. Taking a lock adds it to the held set, the way a
 * browser would — so a module that never requests one is never reported alive.
 */
function fakeLocks(
  held: LockInfo[],
  opts: { rejectRequest?: boolean; rejectQuery?: boolean } = {},
) {
  const requested: string[] = [];
  const locks = {
    request: (name: string, ...rest: unknown[]) => {
      requested.push(name);
      if (opts.rejectRequest) return Promise.reject(new DOMException('nope', 'SecurityError'));
      held.push({ name });
      const fn = rest[rest.length - 1] as (lock: unknown) => Promise<void>;
      // The real callback never returns (the lock is held for the page's life),
      // so this doesn't await it either.
      void fn({});
      return new Promise<void>(() => {});
    },
    query: async () => {
      if (opts.rejectQuery) throw new DOMException('nope', 'InvalidStateError');
      return { held, pending: [] };
    },
  };
  return { locks, requested };
}

const originalNavigator = globalThis.navigator;

function setNavigator(value: unknown) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  setNavigator(originalNavigator);
});

describe('liveSessionIds', () => {
  it('reports every held session lock', async () => {
    setNavigator({
      locks: fakeLocks([{ name: 'wnotes-session-aaa' }, { name: 'wnotes-session-bbb' }]).locks,
    });
    const { liveSessionIds } = await import('@/lib/page-session');
    const live = await liveSessionIds();
    expect(live?.has('aaa')).toBe(true);
    expect(live?.has('bbb')).toBe(true);
  });

  it('ignores locks that are not session locks', async () => {
    // The DB-owner lock shares this namespace; counting it as a session would
    // keep dead rows alive forever.
    setNavigator({ locks: fakeLocks([{ name: 'wnotes-db-owner' }]).locks });
    const { liveSessionIds, pageSessionId } = await import('@/lib/page-session');
    const live = await liveSessionIds();
    expect(live?.has('wnotes-db-owner')).toBe(false);
    // Only this page's own session, which it took on the way in.
    expect(Array.from(live ?? [])).toEqual([pageSessionId()]);
  });

  it('takes its own lock before reading, so a page never clears its fresh rows', async () => {
    // The fake only reports a lock it was actually asked for. A version that
    // skipped the request, or read the set before the grant, fails here — which
    // is the property the whole change rests on.
    const fake = fakeLocks([]);
    setNavigator({ locks: fake.locks });
    const { liveSessionIds, pageSessionId } = await import('@/lib/page-session');
    const live = await liveSessionIds();
    expect(fake.requested).toEqual([`wnotes-session-${pageSessionId()}`]);
    expect(live?.has(pageSessionId())).toBe(true);
  });

  it('returns null when the browser has no Web Locks', async () => {
    // The caller reads null as "clear everything" — the pre-session behaviour,
    // which is the right answer where liveness is unknowable.
    setNavigator({});
    const { liveSessionIds } = await import('@/lib/page-session');
    expect(await liveSessionIds()).toBeNull();
  });

  it('returns null when the lock request is rejected', async () => {
    // Opaque origins reject with SecurityError while navigator.locks still
    // exists. Resolving to null is what keeps the database open from hanging on
    // a promise that never settles.
    setNavigator({ locks: fakeLocks([], { rejectRequest: true }).locks });
    const { liveSessionIds } = await import('@/lib/page-session');
    expect(await liveSessionIds()).toBeNull();
  });

  it('returns null when querying the locks fails', async () => {
    // This runs inside the database open, which had no failure mode here
    // before; throwing out of it would take the whole connection down.
    setNavigator({ locks: fakeLocks([], { rejectQuery: true }).locks });
    const { liveSessionIds } = await import('@/lib/page-session');
    await expect(liveSessionIds()).resolves.toBeNull();
  });
});

describe('pageSessionId', () => {
  it('is stable within a page', async () => {
    setNavigator({ locks: fakeLocks([]) });
    const { pageSessionId } = await import('@/lib/page-session');
    expect(pageSessionId()).toBe(pageSessionId());
  });

  it('differs between pages', async () => {
    setNavigator({ locks: fakeLocks([]) });
    const first = (await import('@/lib/page-session')).pageSessionId();
    vi.resetModules();
    const second = (await import('@/lib/page-session')).pageSessionId();
    expect(second).not.toBe(first);
  });
});
