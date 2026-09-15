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

/** First requester wins the lock; later ones are told it's taken. */
function fakeLockManager(held: Set<string>) {
  return {
    request: (name: string, ...rest: unknown[]) => {
      const opts = (typeof rest[0] === 'object' ? rest[0] : {}) as { ifAvailable?: boolean };
      const cb = rest[rest.length - 1] as (lock: unknown) => Promise<void>;
      if (!opts.ifAvailable) return new Promise<void>(() => {}); // queued forever
      if (held.has(name)) return Promise.resolve(cb(null));
      held.add(name);
      void cb({ name });
      return new Promise<void>(() => {});
    },
    query: async () => ({ held: [], pending: [] }),
  };
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
