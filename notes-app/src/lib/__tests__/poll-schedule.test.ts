import { describe, expect, it } from 'vitest';

import {
  ACTIVE_MS,
  ACTIVE_WINDOW_MS,
  IDLE_MS,
  nextPollDelay,
} from '@/lib/sync/poll-schedule';

describe('nextPollDelay', () => {
  it('polls tight while sync is moving data', () => {
    expect(nextPollDelay(0)).toBe(ACTIVE_MS);
    expect(nextPollDelay(ACTIVE_WINDOW_MS - 1)).toBe(ACTIVE_MS);
  });

  it('relaxes once the window has passed', () => {
    expect(nextPollDelay(ACTIVE_WINDOW_MS)).toBe(IDLE_MS);
    expect(nextPollDelay(10 * ACTIVE_WINDOW_MS)).toBe(IDLE_MS);
  });

  it('stays lazy in a session where nothing has changed yet', () => {
    expect(nextPollDelay(Infinity)).toBe(IDLE_MS);
  });

  it('keeps a remote edit visible within a few seconds of it landing', () => {
    // The regression this exists for: a flat 15s interval meant an edit made on
    // another device could sit unseen long enough to read as broken sync.
    expect(ACTIVE_MS).toBeLessThanOrEqual(3_000);
    expect(IDLE_MS).toBeLessThanOrEqual(15_000);
  });
});
