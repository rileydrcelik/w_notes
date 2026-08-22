import { describe, expect, it } from 'vitest';

import type { Folder, Note } from '@/data/notes';
import {
  folderConfigWithMaster,
  folderMasterResumeId,
  isMasterResume,
  masterResumeFor,
} from '@/lib/resume-master';

const folder = (overrides: Partial<Folder> = {}): Folder => ({
  id: 'folder-1',
  name: 'Backend jobs',
  parentId: null,
  ...overrides,
});

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'note-1',
  title: 'My resume',
  body: '\\documentclass{article}',
  folderId: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  pluginType: 'resume',
  ...overrides,
});

describe('folderMasterResumeId', () => {
  it('reads the master id out of config', () => {
    const f = folder({ config: JSON.stringify({ masterResumeId: 'note-1' }) });
    expect(folderMasterResumeId(f)).toBe('note-1');
  });

  it('is null when config is absent', () => {
    expect(folderMasterResumeId(folder({ config: undefined }))).toBeNull();
  });

  it('is null rather than throwing on corrupt config', () => {
    expect(folderMasterResumeId(folder({ config: '{not json' }))).toBeNull();
  });

  it('is null when masterResumeId is present but not a usable string', () => {
    expect(folderMasterResumeId(folder({ config: JSON.stringify({ masterResumeId: 5 }) }))).toBeNull();
    expect(
      folderMasterResumeId(folder({ config: JSON.stringify({ masterResumeId: '' }) })),
    ).toBeNull();
  });
});

describe('folderConfigWithMaster', () => {
  it('sets the master while preserving every other key already in config', () => {
    const f = folder({
      config: JSON.stringify({ repo: 'octo/repo', attributes: [{ id: 'a1', name: 'Status' }] }),
    });
    const result = JSON.parse(folderConfigWithMaster(f, 'note-9'));
    expect(result).toEqual({
      repo: 'octo/repo',
      attributes: [{ id: 'a1', name: 'Status' }],
      masterResumeId: 'note-9',
    });
  });

  it('clears the master for null while preserving other keys', () => {
    const f = folder({ config: JSON.stringify({ repo: 'octo/repo', masterResumeId: 'note-1' }) });
    const result = JSON.parse(folderConfigWithMaster(f, null));
    expect(result).toEqual({ repo: 'octo/repo' });
  });

  it('starts from an empty object when config is corrupt rather than propagating it', () => {
    const f = folder({ config: '{not json' });
    const result = JSON.parse(folderConfigWithMaster(f, 'note-1'));
    expect(result).toEqual({ masterResumeId: 'note-1' });
  });
});

describe('masterResumeFor', () => {
  const proj = folder({ id: 'folder-1', config: JSON.stringify({ masterResumeId: 'master-1' }) });

  it('finds the master resume for a note in the same folder', () => {
    const master = note({ id: 'master-1', folderId: 'folder-1' });
    const target = note({ id: 'note-2', folderId: 'folder-1' });
    expect(masterResumeFor(target, [proj], [master, target])?.id).toBe('master-1');
  });

  it('is null for a note on the home screen (no folder to hold a master)', () => {
    const target = note({ id: 'note-2', folderId: null });
    expect(masterResumeFor(target, [proj], [target])).toBeNull();
  });

  it('is null when the folder is missing (not yet synced)', () => {
    // `proj` (folder-1) names 'master-1' as its master. `master` itself
    // belongs to the note's own (unsynced) folder id, so a lookup that fell
    // back to "any folder in the list" instead of the note's actual folder
    // would wrongly resolve `master-1` as the master here — the fallback and
    // the final same-folder check would agree by coincidence.
    const master = note({ id: 'master-1', folderId: 'ghost-folder' });
    const target = note({ id: 'note-2', folderId: 'ghost-folder' });
    expect(masterResumeFor(target, [proj], [master, target])).toBeNull();
  });

  it('is null when the named master note has not synced yet', () => {
    const target = note({ id: 'note-2', folderId: 'folder-1' });
    expect(masterResumeFor(target, [proj], [target])).toBeNull();
  });

  it('is null when the named note is not a resume', () => {
    const notResume = note({ id: 'master-1', folderId: 'folder-1', pluginType: undefined });
    const target = note({ id: 'note-2', folderId: 'folder-1' });
    expect(masterResumeFor(target, [proj], [notResume, target])).toBeNull();
  });

  it('is null when the named note has moved to a different folder', () => {
    const moved = note({ id: 'master-1', folderId: 'other-folder' });
    const target = note({ id: 'note-2', folderId: 'folder-1' });
    expect(masterResumeFor(target, [proj], [moved, target])).toBeNull();
  });
});

describe('isMasterResume', () => {
  it('is true for the note the folder names as master', () => {
    const proj = folder({ id: 'folder-1', config: JSON.stringify({ masterResumeId: 'note-1' }) });
    expect(isMasterResume(note({ id: 'note-1', folderId: 'folder-1' }), [proj])).toBe(true);
  });

  it('is false for a different note in the same folder', () => {
    const proj = folder({ id: 'folder-1', config: JSON.stringify({ masterResumeId: 'note-1' }) });
    expect(isMasterResume(note({ id: 'note-2', folderId: 'folder-1' }), [proj])).toBe(false);
  });

  it('is false for a note on the home screen', () => {
    expect(isMasterResume(note({ id: 'note-1', folderId: null }), [])).toBe(false);
  });
});
