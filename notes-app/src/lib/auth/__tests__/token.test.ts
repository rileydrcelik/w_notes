/**
 * The identity-change notifier in `token.ts`.
 *
 * This is the fix for a real production bug: a saved GitHub/Sentry token
 * showed as "not saved" after a page reload. The status fetch ran from a mount
 * effect with `[]` deps, and on a cold web load it ran before Firebase
 * restored its session — `getAuthToken` threw `AuthUnavailableError` (by
 * design, to avoid forking a signed-in account onto the device key), the
 * store swallowed it, and with no deps it never asked again once the session
 * came back. `subscribeAuthUser` is what lets a one-shot effect ask again
 * when the identity actually resolves — and only then, not on every Firebase
 * token refresh (which fires with the same uid on its own schedule and would
 * otherwise mean an unnecessary refetch loop).
 *
 * `token.ts` imports `@/lib/db` (for `getAuthToken`'s SYNCED_UID check) and
 * `./firebase` (for `firebaseEnabled`), neither of which loads under vitest —
 * `db.ts` pulls in `expo-sqlite`, which pulls in `expo`'s async-require setup
 * and dies on a missing `__DEV__` global outside Metro. Mocking both restores
 * exactly the module surface `subscribeAuthUser`/`setAuthUser` need (they
 * never touch either import) without changing any product code — the same
 * tactic `ai-key.test.ts` uses to load a module that transitively imports the
 * Sentry SDK.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: { getSetting: vi.fn() } }));
vi.mock('../firebase', () => ({ firebaseEnabled: false }));

import { isSignedIn, setAuthUser, subscribeAuthUser } from '../token';

type FirebaseUserLike = Parameters<typeof setAuthUser>[0];

/** A stand-in for `firebase/auth`'s `User` — only `uid` is read by `setAuthUser`. */
const user = (uid: string): FirebaseUserLike => ({ uid }) as unknown as FirebaseUserLike;

// `listeners` is module-level state in token.ts, so anything a test subscribes
// must be unsubscribed before the next test runs, or it leaks into it.
let unsubs: Array<() => void> = [];
function subscribe(listener: () => void): () => void {
  const unsubscribe = subscribeAuthUser(listener);
  unsubs.push(unsubscribe);
  return unsubscribe;
}

beforeEach(() => {
  // `currentUser` is also module-level; put it back to the initial "signed
  // out" state regardless of what the previous test left it as. No listeners
  // are registered yet at this point, so this never itself fires anything.
  setAuthUser(null);
});

afterEach(() => {
  for (const unsubscribe of unsubs) unsubscribe();
  unsubs = [];
});

describe('subscribeAuthUser', () => {
  it('fires when a user signs in from signed out (null -> user)', () => {
    const listener = vi.fn();
    subscribe(listener);

    setAuthUser(user('alice'));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(isSignedIn()).toBe(true);
  });

  it('fires when the account changes (uid -> a different uid)', () => {
    setAuthUser(user('alice')); // establish a baseline identity before subscribing
    const listener = vi.fn();
    subscribe(listener);

    setAuthUser(user('bob'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires on sign-out (user -> null)', () => {
    setAuthUser(user('alice'));
    const listener = vi.fn();
    subscribe(listener);

    setAuthUser(null);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(isSignedIn()).toBe(false);
  });

  it('does NOT fire when the same uid is set again, e.g. a token refresh', () => {
    // This is the regression `setAuthUser` guards against: `onAuthStateChanged`
    // also fires on Firebase's own token-refresh schedule, with the same
    // account. A listener that refetches on every call — instead of every
    // genuine identity change — would hit the credential-status endpoint on
    // that schedule instead of only when something it cares about moved.
    setAuthUser(user('alice'));
    const listener = vi.fn();
    subscribe(listener);

    setAuthUser(user('alice'));

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops delivering to a listener that has unsubscribed, without affecting others still subscribed', () => {
    const unsubscribed = vi.fn();
    const stillSubscribed = vi.fn();
    const unsubscribe = subscribe(unsubscribed);
    subscribe(stillSubscribed);

    unsubscribe();
    setAuthUser(user('alice'));

    expect(unsubscribed).not.toHaveBeenCalled();
    expect(stillSubscribed).toHaveBeenCalledTimes(1);
  });

  it('still calls a later listener when an earlier one unsubscribes itself during notification', () => {
    // Guards the iterate-over-a-copy behaviour: `setAuthUser` walks a copy of
    // the listener set specifically so a listener that unsubscribes itself
    // mid-notification can't cause the set to skip whoever comes after it.
    //
    // Note on mutation-checking this one: for a *self*-unsubscribe specifically,
    // `Set` iteration already tolerates deleting the current (already-visited)
    // entry without skipping what comes after — dropping the `[...listeners]`
    // copy does not turn this test red. It's kept anyway as a direct regression
    // pin of the literal scenario (and of any future switch away from `Set`,
    // which would not get that guarantee for free). The next test exercises the
    // copy in the one way that actually depends on it.
    let unsubscribeSelf!: () => void;
    const self = vi.fn(() => unsubscribeSelf());
    const after = vi.fn();
    unsubscribeSelf = subscribe(self);
    subscribe(after);

    setAuthUser(user('alice'));

    expect(self).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('still calls a listener that an earlier listener unsubscribes during notification', () => {
    // This is the scenario the `[...listeners]` copy actually protects against:
    // unlike self-removal, deleting a *different*, not-yet-visited entry from a
    // live `Set` while iterating it skips that entry entirely (per the `Set`
    // iteration protocol). The remover must be registered — and so notified —
    // before its victim for that to be reachable at all, hence the order below.
    const victim = vi.fn();
    let unsubscribeVictim!: () => void;
    subscribe(() => unsubscribeVictim());
    unsubscribeVictim = subscribe(victim);

    setAuthUser(user('alice'));

    expect(victim).toHaveBeenCalledTimes(1);
  });
});
