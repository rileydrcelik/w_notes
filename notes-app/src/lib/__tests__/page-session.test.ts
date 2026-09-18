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

// ---------------------------------------------------------------------------

describe('holding the session lock', () => {
  it('takes its lock as the module loads, in every tab', async () => {
    // The lock used to be requested lazily, from `liveSessionIds` — which only
    // the tab that opens the database ever calls. Every other tab therefore
    // held no lock and looked dead to the tab doing the clearing, which nulled
    // the `blob:` URL it was still using: for bytes not yet uploaded, that was
    // the file's only copy.
    const fake = fakeLocks([]);
    setNavigator({ locks: fake.locks });

    const { pageSessionId } = await import('@/lib/page-session');

    // Nothing asked about liveness, and this page is already registered.
    expect(fake.requested).toContain(`wnotes-session-${pageSessionId()}`);
  });
});

describe('withPageSession', () => {
  it('stamps the session of the tab that made the call', async () => {
    setNavigator({ locks: fakeLocks([]).locks });
    const { pageSessionId, withPageSession } = await import('@/lib/page-session');
    const createCopa = vi.fn(async (_input: { id?: string; fileSession?: string }) => {});
    const setCopaLocalFile = vi.fn(
      async (_id: string, _uri: string, _thumb: string | null, _session?: string) => {},
    );
    const createNoteImage = vi.fn(async (_input: { id?: string; fileSession?: string }) => {});
    const setNoteImageLocalFile = vi.fn(
      async (_id: string, _uri: string, _session?: string) => {},
    );

    const api = withPageSession({
      createCopa,
      setCopaLocalFile,
      createNoteImage,
      setNoteImageLocalFile,
    });
    await api.createCopa({ id: 'c1' });
    await api.setCopaLocalFile('c1', 'blob:abc', null);
    await api.createNoteImage({ id: 'i1' });
    await api.setNoteImageLocalFile('i1', 'blob:def');

    // Both methods run in whichever tab holds the database, so a session read
    // inside their bodies names that tab rather than the one that minted the
    // URL being stamped.
    expect(createCopa).toHaveBeenCalledWith({ id: 'c1', fileSession: pageSessionId() });
    expect(setCopaLocalFile).toHaveBeenCalledWith('c1', 'blob:abc', null, pageSessionId());
    // A note image's bytes are held the same way and need the same stamp.
    expect(createNoteImage).toHaveBeenCalledWith({ id: 'i1', fileSession: pageSessionId() });
    expect(setNoteImageLocalFile).toHaveBeenCalledWith('i1', 'blob:def', pageSessionId());
  });

  it('passes every other method through untouched', async () => {
    setNavigator({ locks: fakeLocks([]).locks });
    const { withPageSession } = await import('@/lib/page-session');

    const api = withPageSession({
      createCopa: async (_input: { fileSession?: string }) => {},
      setCopaLocalFile: async (
        _id: string,
        _uri: string,
        _thumb: string | null,
        _session?: string,
      ) => {},
      createNoteImage: async (_input: { fileSession?: string }) => {},
      setNoteImageLocalFile: async (_id: string, _uri: string, _session?: string) => {},
      getNote: async (id: string) => `note ${id}`,
    });

    await expect(api.getNote('n1')).resolves.toBe('note n1');
  });
});
