import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two tabs, one database. The owning tab serves; the other asks.
 *
 * Each "tab" is a fresh module instance (`vi.resetModules()`), sharing one fake
 * `BroadcastChannel` registry and one fake `LockManager` — so election and
 * transport behave the way two real documents would, and a follower that
 * touched its own database would be visibly wrong rather than quietly fine.
 */

type Listener = ((e: { data: unknown }) => void) | null;

const registry = new Map<string, Set<FakeChannel>>();

class FakeChannel {
  name: string;
  onmessage: Listener = null;
  constructor(name: string) {
    this.name = name;
    if (!registry.has(name)) registry.set(name, new Set());
    registry.get(name)!.add(this);
  }
  postMessage(data: unknown) {
    for (const peer of registry.get(this.name) ?? []) {
      // A real BroadcastChannel never delivers to the sender.
      if (peer === this) continue;
      queueMicrotask(() => peer.onmessage?.({ data }));
    }
  }
  close() {
    registry.get(this.name)?.delete(this);
  }
}

/**
 * First requester wins the lock; later ones are told it's taken and queue. A
 * queued request is granted by `handOverLock`, which is what the browser does
 * for a tab that took over — the ordinary way a guarded tab stops being guarded.
 */
const queued: ((lock: unknown) => Promise<void>)[] = [];

function fakeLockManager(held: Set<string>) {
  return {
    request: (name: string, ...rest: unknown[]) => {
      const opts = (typeof rest[0] === 'object' ? rest[0] : {}) as { ifAvailable?: boolean };
      const cb = rest[rest.length - 1] as (lock: unknown) => Promise<void>;
      if (!opts.ifAvailable) {
        queued.push(cb);
        return new Promise<void>(() => {}); // held until granted
      }
      if (held.has(name)) return Promise.resolve(cb(null));
      held.add(name);
      void cb({ name });
      return new Promise<void>(() => {});
    },
    query: async () => ({ held: [], pending: [] }),
  };
}

/** The previous owner let go: grant the lock to the tab that queued first. */
function handOverLock(): void {
  const next = queued.shift();
  void next?.({ name: 'wnotes-db-owner' });
}

const heldLocks = new Set<string>();
const originalNavigator = globalThis.navigator;
const originalBC = globalThis.BroadcastChannel;

function setNavigator(value: unknown) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

/** Load a fresh module instance, i.e. another tab. */
async function openTab() {
  vi.resetModules();
  return import('@/lib/db-tabs');
}

/** Let queued microtasks and channel deliveries run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  registry.clear();
  heldLocks.clear();
  queued.length = 0;
  setNavigator({ locks: fakeLockManager(heldLocks) });
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeChannel;
});

afterEach(() => {
  setNavigator(originalNavigator);
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = originalBC;
});

describe('a follower tab calling the owner', () => {
  it('runs the call on the owner and returns its result', async () => {
    const ownerCalls: unknown[][] = [];
    const owner = await openTab();
    owner.shareDbAcrossTabs({
      getNote: async (...args: unknown[]) => {
        ownerCalls.push(args);
        return { id: args[0], title: 'from the owner' };
      },
    });
    await flush();

    const follower = await openTab();
    const followerDb = follower.shareDbAcrossTabs({
      getNote: async (..._args: unknown[]) => {
        throw new Error('a follower must never touch its own database');
      },
    });

    await expect(followerDb.getNote('n1')).resolves.toEqual({
      id: 'n1',
      title: 'from the owner',
    });
    expect(ownerCalls).toEqual([['n1']]);
  });

  it('carries a rejection back with its name intact', async () => {
    // `isDbLockedError` and Sentry grouping both key off `name`, and a
    // structured clone of an Error subclass would not preserve it.
    const owner = await openTab();
    owner.shareDbAcrossTabs({
      createNote: async () => {
        const e = new Error('another tab owns the file');
        e.name = 'NoModificationAllowedError';
        throw e;
      },
    });
    await flush();

    const follower = await openTab();
    const followerDb = follower.shareDbAcrossTabs({ createNote: async () => 'unused' });

    await expect(followerDb.createNote()).rejects.toMatchObject({
      name: 'NoModificationAllowedError',
      message: 'another tab owns the file',
    });
  });

  it('rejects a method the owner does not have', async () => {
    const owner = await openTab();
    owner.shareDbAcrossTabs({ known: async () => 'ok' });
    await flush();

    const follower = await openTab();
    const followerDb = follower.shareDbAcrossTabs({
      known: async () => 'unused',
      surprise: async () => 'unused',
    }) as Record<string, () => Promise<unknown>>;

    await expect(followerDb.surprise()).rejects.toThrow(/unknown database method surprise/);
  });

  it('forwards arguments unchanged', async () => {
    const seen: unknown[][] = [];
    const owner = await openTab();
    owner.shareDbAcrossTabs({
      updateNote: async (...args: unknown[]) => {
        seen.push(args);
      },
    });
    await flush();

    const follower = await openTab();
    const followerDb = follower.shareDbAcrossTabs({
      updateNote: async (..._args: unknown[]) => {},
    });
    await followerDb.updateNote('id-1', { title: 'x' }, null, 0);

    expect(seen).toEqual([['id-1', { title: 'x' }, null, 0]]);
  });
});

describe('the owning tab', () => {
  it('runs its own calls locally rather than over the channel', async () => {
    let ran = false;
    const owner = await openTab();
    const ownerDb = owner.shareDbAcrossTabs({
      getNote: async () => {
        ran = true;
        return 'local';
      },
    });

    await expect(ownerDb.getNote()).resolves.toBe('local');
    expect(ran).toBe(true);
  });
});

describe('telling the other tabs the database changed', () => {
  it('announces a write that changes what someone is looking at', async () => {
    const owner = await openTab();
    const ownerDb = owner.shareDbAcrossTabs(
      { createNote: async () => {} },
      { invalidates: ['createNote'] },
    );
    await flush();

    const follower = await openTab();
    follower.shareDbAcrossTabs({ createNote: async () => {} }, { invalidates: ['createNote'] });
    const heard = vi.fn();
    follower.subscribeDbChanged(heard);

    await ownerDb.createNote();
    await new Promise((r) => setTimeout(r, 200)); // past the coalescing window

    expect(heard).toHaveBeenCalled();
  });

  it('says nothing for housekeeping, so two tabs cannot wake each other forever', async () => {
    // Re-reading runs `purgeExpiredTrash`, which is itself a write. Announce it
    // and tab A wakes tab B, which wakes tab A, for as long as both are open.
    const owner = await openTab();
    const ownerDb = owner.shareDbAcrossTabs(
      { purgeExpiredTrash: async () => {} },
      { invalidates: [] },
    );
    await flush();

    const follower = await openTab();
    follower.shareDbAcrossTabs({ purgeExpiredTrash: async () => {} }, { invalidates: [] });
    const heard = vi.fn();
    follower.subscribeDbChanged(heard);

    await ownerDb.purgeExpiredTrash();
    await new Promise((r) => setTimeout(r, 200));

    expect(heard).not.toHaveBeenCalled();
  });

  it('wakes the owner too when it served a write for somebody else', async () => {
    // The write came from another tab, so nothing here applied it optimistically
    // — without this the owner keeps rendering stale content it wrote itself.
    const owner = await openTab();
    owner.shareDbAcrossTabs({ createNote: async () => {} }, { invalidates: ['createNote'] });
    const ownerHeard = vi.fn();
    owner.subscribeDbChanged(ownerHeard);
    await flush();

    const follower = await openTab();
    const followerDb = follower.shareDbAcrossTabs(
      { createNote: async () => {} },
      { invalidates: ['createNote'] },
    );

    await followerDb.createNote();
    await new Promise((r) => setTimeout(r, 200));

    expect(ownerHeard).toHaveBeenCalled();
  });

  it('coalesces a burst into one announcement', async () => {
    const owner = await openTab();
    const ownerDb = owner.shareDbAcrossTabs(
      { updateNote: async () => {} },
      { invalidates: ['updateNote'] },
    );
    await flush();

    const follower = await openTab();
    follower.shareDbAcrossTabs({ updateNote: async () => {} }, { invalidates: ['updateNote'] });
    const heard = vi.fn();
    follower.subscribeDbChanged(heard);

    for (let i = 0; i < 10; i++) await ownerDb.updateNote();
    await new Promise((r) => setTimeout(r, 200));

    expect(heard).toHaveBeenCalledTimes(1);
  });
});

/**
 * A frozen owner. The browser stops running a background tab's tasks without
 * closing it or releasing its lock, so from here it looks like a tab that is
 * still there and answers nothing. Silencing its request handler is exactly
 * that, and restoring it is the thaw when the user looks at it again.
 */
function freezeOwner(): () => void {
  const [ownerChannel] = [...(registry.get('wnotes-db-rpc') ?? [])];
  const handler = ownerChannel.onmessage;
  ownerChannel.onmessage = null;
  return () => {
    ownerChannel.onmessage = handler;
  };
}

describe('noticing that the owning tab stopped answering', () => {
  it('says nothing is wrong while the owner answers', async () => {
    const owner = await openTab();
    owner.shareDbAcrossTabs({ getNote: async () => 'ok' });
    await flush();

    const follower = await openTab();
    follower.shareDbAcrossTabs({ getNote: async () => 'unused' });

    expect(follower.isDbUnreachable()).toBe(false);
  });

  it('is never unreachable to the tab that holds the database', async () => {
    const owner = await openTab();
    owner.shareDbAcrossTabs({ getNote: async () => 'ok' });
    await flush();

    expect(owner.isDbUnreachable()).toBe(false);
  });

  it('stops being unreachable the moment it takes the database over', async () => {
    // What "Use here" is for. The guard reads this, so if taking over left the
    // tab still looking unreachable the guard would stay up over a tab that now
    // holds the database and is perfectly able to serve everyone else.
    vi.useFakeTimers();
    try {
      const owner = await openTab();
      owner.shareDbAcrossTabs({ getNote: async () => 'ok' });
      await vi.advanceTimersByTimeAsync(1);

      const follower = await openTab();
      const followerDb = follower.shareDbAcrossTabs({ getNote: async () => 'local' });
      const heard = vi.fn();
      follower.subscribeDbReachable(heard);

      freezeOwner();
      void followerDb.getNote().catch(() => {});
      await vi.advanceTimersByTimeAsync(30_000);
      expect(follower.isDbUnreachable()).toBe(true);
      heard.mockClear();

      // The unresponsive owner reloaded and let go of the lock.
      handOverLock();
      await vi.advanceTimersByTimeAsync(1);

      expect(follower.isDbUnreachable()).toBe(false);
      // Taking over is not itself a reply, so the only thing that can tell a
      // listener the guard should come down is the role change.
      expect(heard).toHaveBeenCalled();
      await expect(followerDb.getNote()).resolves.toBe('local');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on an owner that never answers, and tells its listeners', async () => {
    vi.useFakeTimers();
    try {
      const owner = await openTab();
      owner.shareDbAcrossTabs({ getNote: async () => 'ok' });
      await vi.advanceTimersByTimeAsync(1);

      const follower = await openTab();
      const followerDb = follower.shareDbAcrossTabs({ getNote: async () => 'unused' });
      const heard = vi.fn();
      follower.subscribeDbReachable(heard);

      freezeOwner();
      // Handled synchronously: the rejection lands inside the timer advance
      // below, and attaching afterwards would make it an unhandled rejection.
      const settled = followerDb.getNote().then(
        () => null,
        (e: Error) => e,
      );
      // The call is still outstanding, so nothing is known yet.
      await vi.advanceTimersByTimeAsync(1);
      expect(follower.isDbUnreachable()).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(await settled).toMatchObject({ name: 'DbOwnerLost' });
      expect(follower.isDbUnreachable()).toBe(true);
      expect(heard).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('notices on its own when the owner comes back', async () => {
    // Nothing else would ask: the guard is covering the screen and the
    // once-per-profile jobs belong to the owner, so without the probe this tab
    // stays behind the guard for as long as it is open.
    vi.useFakeTimers();
    try {
      const owner = await openTab();
      owner.shareDbAcrossTabs({ getNote: async () => 'ok' });
      await vi.advanceTimersByTimeAsync(1);

      const follower = await openTab();
      const followerDb = follower.shareDbAcrossTabs({ getNote: async () => 'unused' });
      const heard = vi.fn();
      follower.subscribeDbReachable(heard);

      const thaw = freezeOwner();
      void followerDb.getNote().catch(() => {});
      await vi.advanceTimersByTimeAsync(30_000);
      expect(follower.isDbUnreachable()).toBe(true);

      thaw();
      await vi.advanceTimersByTimeAsync(3_000);

      expect(follower.isDbUnreachable()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops asking once nobody is listening', async () => {
    vi.useFakeTimers();
    try {
      const owner = await openTab();
      owner.shareDbAcrossTabs({ getNote: async () => 'ok' });
      await vi.advanceTimersByTimeAsync(1);

      const follower = await openTab();
      const followerDb = follower.shareDbAcrossTabs({ getNote: async () => 'unused' });
      const stop = follower.subscribeDbReachable(() => {});

      const thaw = freezeOwner();
      void followerDb.getNote().catch(() => {});
      await vi.advanceTimersByTimeAsync(30_000);
      stop();
      thaw();

      const asked = vi.fn();
      const [ownerChannel] = [...(registry.get('wnotes-db-rpc') ?? [])];
      ownerChannel.onmessage = asked;
      await vi.advanceTimersByTimeAsync(9_000);

      expect(asked).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('has nothing to reach when the browser has no BroadcastChannel', async () => {
    // Another tab already holds the database, and this one has no way to ask it
    // for anything. Election itself needs only the Web Locks API, so the tab
    // still knows it is a follower — it just has nowhere to send a call.
    heldLocks.add('wnotes-db-owner');
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
    const tab = await openTab();
    tab.shareDbAcrossTabs({ getNote: async () => 'unused' });
    await flush();

    expect(tab.isDbUnreachable()).toBe(true);
  });
});
