/**
 * The trash's retention arithmetic. Both directions of a mistake here are
 * expensive: too generous and the trash never empties, too eager and something
 * the user still meant to restore is gone for good — and the purge that acts on
 * `isTrashExpired` is the one hard delete in the app. So the boundary day is
 * pinned from both sides.
 */
import { describe, expect, it } from 'vitest';

import {
  daysLeftInTrash,
  isTrashExpired,
  trashExpiresAt,
  TRASH_RETENTION_DAYS,
  TRASH_RETENTION_MS,
} from '@/lib/trash-retention';

const DAY = 24 * 60 * 60 * 1000;
const deletedAt = Date.UTC(2026, 0, 1);

describe('the retention window', () => {
  it('is 30 days', () => {
    expect(TRASH_RETENTION_DAYS).toBe(30);
    expect(TRASH_RETENTION_MS).toBe(30 * DAY);
  });

  it('expires an entry 30 days after it was deleted', () => {
    expect(trashExpiresAt(deletedAt)).toBe(deletedAt + 30 * DAY);
  });
});

describe('isTrashExpired', () => {
  it('keeps an entry deleted moments ago', () => {
    expect(isTrashExpired(deletedAt, deletedAt + 1000)).toBe(false);
  });

  it('keeps an entry on its 29th day', () => {
    expect(isTrashExpired(deletedAt, deletedAt + 29 * DAY)).toBe(false);
  });

  it('still keeps it at exactly 30 days — the window is inclusive', () => {
    expect(isTrashExpired(deletedAt, deletedAt + 30 * DAY)).toBe(false);
  });

  it('expires it a moment past 30 days', () => {
    expect(isTrashExpired(deletedAt, deletedAt + 30 * DAY + 1)).toBe(true);
  });

  it('expires an entry long past its window', () => {
    expect(isTrashExpired(deletedAt, deletedAt + 365 * DAY)).toBe(true);
  });

  it('treats a deletion stamped in the future as unexpired rather than expired', () => {
    // Another device's clock can run ahead of this one; the entry should wait,
    // not vanish on arrival.
    expect(isTrashExpired(deletedAt + DAY, deletedAt)).toBe(false);
  });
});

describe('daysLeftInTrash', () => {
  it('reports the full window for a fresh deletion', () => {
    expect(daysLeftInTrash(deletedAt, deletedAt)).toBe(30);
  });

  it('counts down whole days', () => {
    expect(daysLeftInTrash(deletedAt, deletedAt + 10 * DAY)).toBe(20);
  });

  it('rounds a part-day up, so anything with time left reads as at least 1 day', () => {
    expect(daysLeftInTrash(deletedAt, deletedAt + 29 * DAY + 1)).toBe(1);
    expect(daysLeftInTrash(deletedAt, deletedAt + 29.5 * DAY)).toBe(1);
  });

  it('never goes negative once the entry has expired', () => {
    expect(daysLeftInTrash(deletedAt, deletedAt + 30 * DAY)).toBe(0);
    expect(daysLeftInTrash(deletedAt, deletedAt + 100 * DAY)).toBe(0);
  });
});
