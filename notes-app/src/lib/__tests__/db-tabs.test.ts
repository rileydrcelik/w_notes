import { describe, expect, it } from 'vitest';

import { shareDbAcrossTabs } from '@/lib/db-tabs';

/**
 * Every database call in the app goes through this wrapper, so a method it
 * drops, an argument it mangles or a rejection it swallows would be a silent
 * hole under the whole data layer.
 */

describe('shareDbAcrossTabs', () => {
  it('exposes every method of the object it wraps', () => {
    const api = {
      getNotes: async () => [],
      createNote: async () => {},
      deleteNote: async () => {},
    };
    expect(Object.keys(shareDbAcrossTabs(api)).sort()).toEqual([
      'createNote',
      'deleteNote',
      'getNotes',
    ]);
  });

  it('forwards every argument, unchanged and in order', async () => {
    const seen: unknown[][] = [];
    const api = {
      updateNote: async (...args: unknown[]) => {
        seen.push(args);
      },
    };
    await shareDbAcrossTabs(api).updateNote('id-1', { title: 'x' }, null, 0);
    expect(seen).toEqual([['id-1', { title: 'x' }, null, 0]]);
  });

  it('returns what the method returned', async () => {
    const api = { bootstrap: async () => ({ notes: [{ id: 'n1' }] }) };
    await expect(shareDbAcrossTabs(api).bootstrap()).resolves.toEqual({ notes: [{ id: 'n1' }] });
  });

  it('propagates a rejection rather than swallowing it', async () => {
    const api = {
      createNote: async () => {
        throw new Error('disk full');
      },
    };
    await expect(shareDbAcrossTabs(api).createNote()).rejects.toThrow('disk full');
  });

  it('calls through on every call, so a method replaced later is honoured', async () => {
    // `db.ts` rebinds each mutating method through the write chain after the
    // object is built; a wrapper that captured the originals would route around
    // the serialization entirely.
    const api = { createNote: async () => 'original' };
    const shared = shareDbAcrossTabs(api);
    api.createNote = async () => 'replaced';
    await expect(shared.createNote()).resolves.toBe('replaced');
  });

  it('carries non-function properties across untouched', () => {
    const api = { version: 3, getNotes: async () => [] };
    expect(shareDbAcrossTabs(api).version).toBe(3);
  });

  it('keeps one stable identity per method', () => {
    // Callers hold `db` for the life of the app; ownership changing must not
    // mean handing out a different function.
    const shared = shareDbAcrossTabs({ getNotes: async () => [] });
    expect(shared.getNotes).toBe(shared.getNotes);
  });
});
