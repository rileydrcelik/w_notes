/**
 * The navbar's edit-button registry.
 *
 * It's twelve lines of module state, but the navbar's trailing button — the only
 * way into edit mode on a note, a copy block or a resume — is driven entirely by
 * it, and every failure mode here is silent: the button quietly stays a `+`, or
 * quietly edits the wrong screen. None of that throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearEditAction,
  getEditAction,
  runEditAction,
  setEditAction,
  subscribeEditAction,
} from '@/lib/edit-action';

// Module-level state, so each test starts from an empty registration.
beforeEach(() => setEditAction(null));

describe('runEditAction', () => {
  it('reports that nothing is registered', () => {
    expect(runEditAction()).toBe(false);
  });

  it('runs the registered action', () => {
    const edit = vi.fn();
    setEditAction(edit);

    expect(runEditAction()).toBe(true);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('stops running an action that has been withdrawn', () => {
    const edit = vi.fn();
    setEditAction(edit);
    clearEditAction(edit);

    expect(runEditAction()).toBe(false);
    expect(edit).not.toHaveBeenCalled();
  });
});

describe('clearEditAction', () => {
  // The reason this takes an argument at all. Screens register on focus and
  // clear on blur, and React Navigation doesn't promise the outgoing screen's
  // cleanup runs before the incoming screen's effect — so the two orderings
  // below both happen in practice, and a blind `setEditAction(null)` would
  // leave the new screen showing a create button instead of a pencil.
  it('leaves a newer registration alone when an older screen cleans up late', () => {
    const outgoing = vi.fn();
    const incoming = vi.fn();

    setEditAction(outgoing);
    setEditAction(incoming); // the new screen took focus first…
    clearEditAction(outgoing); // …and only then did the old one blur

    expect(getEditAction()).toBe(incoming);
    expect(runEditAction()).toBe(true);
    expect(incoming).toHaveBeenCalledTimes(1);
    expect(outgoing).not.toHaveBeenCalled();
  });

  it('clears when the owner is still the registered one', () => {
    const outgoing = vi.fn();
    setEditAction(outgoing);
    clearEditAction(outgoing);

    expect(getEditAction()).toBeNull();
  });
});

describe('subscribeEditAction', () => {
  // The navbar swaps its icon from a subscription; a missed notification means
  // the button keeps rendering whatever it showed on the previous screen.
  it('notifies subscribers when an action is registered and withdrawn', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeEditAction(listener);
    const edit = vi.fn();

    setEditAction(edit);
    expect(listener).toHaveBeenCalledTimes(1);

    clearEditAction(edit);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    subscribeEditAction(listener)();

    setEditAction(vi.fn());

    expect(listener).not.toHaveBeenCalled();
  });
});
