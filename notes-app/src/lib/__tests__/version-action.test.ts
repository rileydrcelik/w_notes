/**
 * The navbar's version-history registry.
 *
 * A sibling of `edit-action.ts` with the same shape and the same failure modes,
 * all of them silent: the trailing button quietly stays a `+`, or quietly opens
 * the history of a resume you have already navigated away from. Nothing throws.
 *
 * The ownership check in `clearVersionAction` matters more here than it looks. The
 * resume screen registers a version action and note/copa screens register an
 * *edit* action, so navigating between them crosses two different registries —
 * and if a late-blurring resume screen could wipe the slot unconditionally, the
 * note you just opened would show a create button where its pencil belongs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearVersionAction,
  getVersionAction,
  getVersionKeepsWhileEditing,
  runVersionAction,
  setVersionAction,
  subscribeVersionAction,
} from '@/lib/version-action';

// Module-level state, so each test starts from an empty registration.
beforeEach(() => setVersionAction(null));

describe('runVersionAction', () => {
  it('reports that nothing is registered', () => {
    expect(runVersionAction()).toBe(false);
  });

  it('runs the registered action', () => {
    const open = vi.fn();
    setVersionAction(open);

    expect(runVersionAction()).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('stops running an action that has been withdrawn', () => {
    const open = vi.fn();
    setVersionAction(open);
    clearVersionAction(open);

    expect(runVersionAction()).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('clearVersionAction', () => {
  it('leaves a newer registration alone when an older screen cleans up late', () => {
    const outgoing = vi.fn();
    const incoming = vi.fn();

    setVersionAction(outgoing);
    setVersionAction(incoming); // the new screen took focus first…
    clearVersionAction(outgoing); // …and only then did the old one blur

    expect(getVersionAction()).toBe(incoming);
    expect(runVersionAction()).toBe(true);
    expect(incoming).toHaveBeenCalledTimes(1);
    expect(outgoing).not.toHaveBeenCalled();
  });

  it('clears when the owner is still the registered one', () => {
    const outgoing = vi.fn();
    setVersionAction(outgoing);
    clearVersionAction(outgoing);

    expect(getVersionAction()).toBeNull();
  });
});

describe('getVersionKeepsWhileEditing', () => {
  // What this guards is an *absence* on screen: when it wrongly reads true, the
  // navbar never enters done mode, so the trailing button never becomes the check
  // and — because the export icon hangs off the same flag — a download button sits
  // in the bar the whole time you are typing. Both are things you have to notice
  // are missing, which is why they survived a hand-test.
  it('defaults to false when a screen registers without asking', () => {
    setVersionAction(vi.fn());

    expect(getVersionKeepsWhileEditing()).toBe(false);
  });

  it('holds the slot when the screen asks for it', () => {
    setVersionAction(vi.fn(), { keepWhileEditing: true });

    expect(getVersionKeepsWhileEditing()).toBe(true);
  });

  it('drops the request when the action is withdrawn', () => {
    const open = vi.fn();
    setVersionAction(open, { keepWhileEditing: true });
    clearVersionAction(open);

    expect(getVersionKeepsWhileEditing()).toBe(false);
  });

  it('re-registers the same action when only the request changed', () => {
    // The resume screen crossing the split threshold mid-view: same callback,
    // opposite answer. Comparing actions alone would swallow this and leave the
    // navbar on the stale layout's behaviour until something else re-rendered it.
    const listener = vi.fn();
    const open = vi.fn();
    setVersionAction(open, { keepWhileEditing: true });

    const unsubscribe = subscribeVersionAction(listener);
    setVersionAction(open, { keepWhileEditing: false });

    expect(getVersionKeepsWhileEditing()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe('subscribeVersionAction', () => {
  it('notifies subscribers when an action is registered and withdrawn', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVersionAction(listener);
    const open = vi.fn();

    setVersionAction(open);
    expect(listener).toHaveBeenCalledTimes(1);

    clearVersionAction(open);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('does not notify when the same action is registered twice', () => {
    // The navbar re-renders on every screen change; a notification per render
    // would be a wasted icon swap each time.
    const listener = vi.fn();
    const open = vi.fn();
    setVersionAction(open);

    const unsubscribe = subscribeVersionAction(listener);
    setVersionAction(open);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    subscribeVersionAction(listener)();

    setVersionAction(vi.fn());

    expect(listener).not.toHaveBeenCalled();
  });
});
