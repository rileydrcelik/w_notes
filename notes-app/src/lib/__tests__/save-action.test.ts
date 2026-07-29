/**
 * The navbar's save-button registry.
 *
 * Same shape and the same silent failure modes as `edit-action` — the download
 * icon quietly never appears, or quietly exports the previous screen's document
 * — with one addition: this registry can be empty *while a screen is focused*
 * (a resume that hasn't compiled yet), so "nothing registered" is a normal
 * state, not a bug.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearSaveAction,
  getSaveAction,
  setSaveAction,
  subscribeSaveAction,
  type SaveAction,
} from '@/lib/save-action';

const action = (label: string): SaveAction => ({ label, run: vi.fn() });

// Module-level state, so each test starts from an empty registration.
beforeEach(() => setSaveAction(null));

describe('getSaveAction', () => {
  it('is null when no screen offers an export', () => {
    expect(getSaveAction()).toBeNull();
  });

  it('hands back the registered action, label and all', () => {
    const save = action('Download resume PDF');
    setSaveAction(save);

    const current = getSaveAction();
    expect(current).toBe(save);
    current?.run();
    expect(save.run).toHaveBeenCalledTimes(1);
  });

  it('is null again once the action is withdrawn', () => {
    const save = action('Download resume PDF');
    setSaveAction(save);
    clearSaveAction(save);

    expect(getSaveAction()).toBeNull();
  });
});

describe('clearSaveAction', () => {
  // The reason this takes an argument at all. Screens register on focus and
  // clear on blur, and React Navigation doesn't promise the outgoing screen's
  // cleanup runs before the incoming screen's effect — so a blind
  // `setSaveAction(null)` would drop the new screen's download button.
  it('leaves a newer registration alone when an older screen cleans up late', () => {
    const outgoing = action('Download resume PDF');
    const incoming = action('Save note to device');

    setSaveAction(outgoing);
    setSaveAction(incoming); // the new screen took focus first…
    clearSaveAction(outgoing); // …and only then did the old one blur

    expect(getSaveAction()).toBe(incoming);
  });
});

describe('subscribeSaveAction', () => {
  // The navbar grows and shrinks the pill from this subscription; a missed
  // notification leaves a download icon on a screen with nothing to download.
  it('notifies subscribers when an action is registered and withdrawn', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSaveAction(listener);
    const save = action('Download resume PDF');

    setSaveAction(save);
    expect(listener).toHaveBeenCalledTimes(1);

    clearSaveAction(save);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    subscribeSaveAction(listener)();

    setSaveAction(action('Download resume PDF'));

    expect(listener).not.toHaveBeenCalled();
  });
});
