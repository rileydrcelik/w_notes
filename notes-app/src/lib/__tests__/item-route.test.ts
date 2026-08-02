/**
 * `item-route.ts` is the single source of truth for where a note or folder
 * opens and whether it belongs in a list at all. It exists because the right
 * sidebar used to send every note — including the task manager's internal
 * `issuetype` notes — to `/note/[id]` regardless of `pluginType`. A test that
 * only checks one plugin type would miss exactly the bug this module fixes:
 * one branch swallowing every other type. So every branch of every switch is
 * asserted here, not just a representative sample.
 */
import { describe, expect, it } from 'vitest';

import type { Note } from '@/data/notes';
import { folderHref, isListableNote, noteHref, noteIcon } from '@/lib/item-route';

describe('isListableNote', () => {
  it('is false for issuetype notes — the task manager\'s internal machinery', () => {
    expect(isListableNote({ pluginType: 'issuetype' })).toBe(false);
  });

  it('is true for a plain note with no pluginType', () => {
    expect(isListableNote({ pluginType: undefined })).toBe(true);
  });

  it.each(['finance', 'resume', 'sentry', 'github'] as const)(
    'is true for pluginType %s',
    (pluginType) => {
      expect(isListableNote({ pluginType })).toBe(true);
    },
  );
});

describe('noteHref', () => {
  it('routes a finance note to /finance/[id]', () => {
    expect(noteHref({ id: 'n1', pluginType: 'finance' })).toEqual({
      pathname: '/finance/[id]',
      params: { id: 'n1' },
    });
  });

  it('routes a resume note to /resume/[id]', () => {
    expect(noteHref({ id: 'n2', pluginType: 'resume' })).toEqual({
      pathname: '/resume/[id]',
      params: { id: 'n2' },
    });
  });

  it('routes a sentry note to /sentry/[id]', () => {
    expect(noteHref({ id: 'n3', pluginType: 'sentry' })).toEqual({
      pathname: '/sentry/[id]',
      params: { id: 'n3' },
    });
  });

  it('routes a github note to /github/[id]', () => {
    expect(noteHref({ id: 'n4', pluginType: 'github' })).toEqual({
      pathname: '/github/[id]',
      params: { id: 'n4' },
    });
  });

  it('routes a plain note (no pluginType) to /note/[id]', () => {
    expect(noteHref({ id: 'n5', pluginType: undefined })).toEqual({
      pathname: '/note/[id]',
      params: { id: 'n5' },
    });
  });

  it('falls back to /note/[id] for an issuetype note rather than throwing or returning undefined', () => {
    expect(noteHref({ id: 'n6', pluginType: 'issuetype' })).toEqual({
      pathname: '/note/[id]',
      params: { id: 'n6' },
    });
  });

  it('falls back to /note/[id] for an unrecognised pluginType', () => {
    expect(
      noteHref({ id: 'n7', pluginType: 'not-a-real-plugin-type' as Note['pluginType'] }),
    ).toEqual({
      pathname: '/note/[id]',
      params: { id: 'n7' },
    });
  });
});

describe('folderHref', () => {
  it('routes a project folder to /project/[id]', () => {
    expect(folderHref({ id: 'f1', kind: 'project' })).toEqual({
      pathname: '/project/[id]',
      params: { id: 'f1' },
    });
  });

  it('routes a plain folder (no kind) to /folder/[id]', () => {
    expect(folderHref({ id: 'f2', kind: undefined })).toEqual({
      pathname: '/folder/[id]',
      params: { id: 'f2' },
    });
  });
});

describe('noteIcon', () => {
  it('uses grid for finance', () => {
    expect(noteIcon({ pluginType: 'finance' })).toBe('grid');
  });

  it('uses alert-triangle for sentry', () => {
    expect(noteIcon({ pluginType: 'sentry' })).toBe('alert-triangle');
  });

  it('uses github for github', () => {
    expect(noteIcon({ pluginType: 'github' })).toBe('github');
  });

  it('uses file-text for a plain note', () => {
    expect(noteIcon({ pluginType: undefined })).toBe('file-text');
  });

  it('uses file-text for resume (no dedicated icon)', () => {
    expect(noteIcon({ pluginType: 'resume' })).toBe('file-text');
  });
});
