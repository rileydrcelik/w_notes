import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ownsBackgroundWork` decides which tab runs the once-per-profile jobs: the
 * sync pass, the GitHub outbox flush, the retitle queue. Answer `true` in two
 * tabs and the same GitHub issue is filed twice and the same title billed
 * twice; answer `false` in the only tab and nothing ever syncs.
 */

type Held = Set<string>;

/** First requester wins the lock; later ones are told it is taken. */
function fakeLockManager(held: Held) {
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

const originalNavigator = globalThis.navigator;
const originalBC = globalThis.BroadcastChannel;

function setNavigator(value: unknown) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

class QuietChannel {
  onmessage: unknown = null;
  postMessage() {}
  close() {}
}

beforeEach(() => {
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = QuietChannel;
});

afterEach(() => {
  setNavigator(originalNavigator);
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = originalBC;
});

describe('ownsBackgroundWork', () => {
  it('is true in the tab that took the database lock', async () => {
    setNavigator({ locks: fakeLockManager(new Set()) });
    vi.resetModules();
    const { ownsBackgroundWork } = await import('@/lib/web-db-lock');
    expect(await ownsBackgroundWork()).toBe(true);
  });

  it('is false in a tab that did not get it', async () => {
    const held: Held = new Set();
    setNavigator({ locks: fakeLockManager(held) });

    // First tab takes the lock.
    vi.resetModules();
    const first = await import('@/lib/web-db-lock');
    expect(await first.ownsBackgroundWork()).toBe(true);

    // Second tab, same browser: the lock is already held.
    vi.resetModules();
    const second = await import('@/lib/web-db-lock');
    expect(await second.ownsBackgroundWork()).toBe(false);
  });

  it('waits for election rather than answering from the default', async () => {
    // Election settles in a later task. Reading the pre-election default would
    // have the owner skip its own first sync pass, which is silent and looks
    // exactly like being offline.
    let grant: (() => void) | null = null;
    setNavigator({
      locks: {
        request: (_name: string, ...rest: unknown[]) => {
          const cb = rest[rest.length - 1] as (lock: unknown) => Promise<void>;
          grant = () => void cb({ name: 'late' });
          return new Promise<void>(() => {});
        },
        query: async () => ({ held: [], pending: [] }),
      },
    });
    vi.resetModules();
    const { ownsBackgroundWork } = await import('@/lib/web-db-lock');

    const answer = ownsBackgroundWork();
    let settledEarly = false;
    void answer.then(() => {
      settledEarly = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settledEarly).toBe(false);

    grant!();
    expect(await answer).toBe(true);
  });

  it('assumes ownership where there are no Web Locks to arbitrate with', async () => {
    // Nothing can be coordinated, so refusing would leave a lone tab that never
    // syncs. The database layer surfaces any real conflict instead.
    setNavigator({});
    vi.resetModules();
    const { ownsBackgroundWork } = await import('@/lib/web-db-lock');
    expect(await ownsBackgroundWork()).toBe(true);
  });
});
