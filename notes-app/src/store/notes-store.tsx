import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { seedFolders, seedNotes, type Folder, type Note } from '@/data/notes';

const today = () => new Date().toISOString().slice(0, 10);
const DAY = 24 * 60 * 60 * 1000;

/** A deleted note or folder held in the trash, restorable until purged. */
export type TrashEntry =
  | { kind: 'note'; id: string; deletedAt: number; note: Note }
  | { kind: 'folder'; id: string; deletedAt: number; folder: Folder; notes: Note[] };

// A couple of placeholder entries so the trash isn't empty on first launch;
// real deletions are prepended ahead of these.
const seedTrash: TrashEntry[] = [
  {
    kind: 'note',
    id: 'trash-seed-1',
    deletedAt: Date.now() - 3 * DAY,
    note: { id: 'trash-seed-1', title: 'Old meeting notes', body: '', folderId: null, updatedAt: today() },
  },
  {
    kind: 'note',
    id: 'trash-seed-2',
    deletedAt: Date.now() - 7 * DAY,
    note: { id: 'trash-seed-2', title: 'Draft announcement', body: '', folderId: null, updatedAt: today() },
  },
];

type NotesContextValue = {
  folders: Folder[];
  notes: Note[];
  getFolder: (id: string) => Folder | undefined;
  getNote: (id: string) => Note | undefined;
  getNotesInFolder: (folderId: string) => Note[];
  getRootNotes: () => Note[];
  /** Creates an empty note in the given folder (null = root) and returns its id. */
  createNote: (folderId: string | null) => string;
  /** Creates an unnamed folder and returns its id. */
  createFolder: () => string;
  updateNote: (id: string, patch: Partial<Pick<Note, 'title' | 'body'>>) => void;
  updateFolder: (id: string, patch: Partial<Pick<Folder, 'name'>>) => void;
  /** Moves a note into a folder, or to the home screen when folderId is null. */
  moveNote: (id: string, folderId: string | null) => void;
  /** Moves a note to the trash. */
  deleteNote: (id: string) => void;
  /** Moves a folder and its notes to the trash together. */
  deleteFolder: (id: string) => void;
  /** Flips the favorite flag on a note. */
  toggleNoteFavorite: (id: string) => void;
  /** Flips the favorite flag on a folder. */
  toggleFolderFavorite: (id: string) => void;
  /** Marks a note as shared so it appears on the Shared screen. */
  markNoteShared: (id: string) => void;
  /** The trashed notes/folders, newest first. */
  trash: TrashEntry[];
  /** Restores a trashed entry back into the live notes/folders. */
  restoreFromTrash: (entryId: string) => void;
};

const NotesContext = createContext<NotesContextValue | null>(null);

/**
 * Holds the live, editable notes and folders, seeded from `@/data/notes`.
 * State lives in memory for the session; durable persistence will be backed
 * by SQL later.
 */
export function NotesProvider({ children }: { children: ReactNode }) {
  const [notes, setNotes] = useState<Note[]>(seedNotes);
  const [folders, setFolders] = useState<Folder[]>(seedFolders);
  const [trash, setTrash] = useState<TrashEntry[]>(seedTrash);

  const createNote = useCallback<NotesContextValue['createNote']>((folderId) => {
    const id = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const note: Note = { id, title: '', body: '', folderId, updatedAt: today() };
    // Prepend so the new note surfaces first in its location.
    setNotes((prev) => [note, ...prev]);
    return id;
  }, []);

  const createFolder = useCallback<NotesContextValue['createFolder']>(() => {
    const id = `folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Prepend so the new folder surfaces first in the hierarchy.
    setFolders((prev) => [{ id, name: '' }, ...prev]);
    return id;
  }, []);

  const updateNote = useCallback<NotesContextValue['updateNote']>((id, patch) => {
    setNotes((prev) =>
      prev.map((note) => (note.id === id ? { ...note, ...patch, updatedAt: today() } : note)),
    );
  }, []);

  const updateFolder = useCallback<NotesContextValue['updateFolder']>((id, patch) => {
    setFolders((prev) => prev.map((folder) => (folder.id === id ? { ...folder, ...patch } : folder)));
  }, []);

  const moveNote = useCallback<NotesContextValue['moveNote']>((id, folderId) => {
    setNotes((prev) =>
      prev.map((note) => (note.id === id ? { ...note, folderId, updatedAt: today() } : note)),
    );
  }, []);

  const deleteNote = useCallback<NotesContextValue['deleteNote']>(
    (id) => {
      const note = notes.find((n) => n.id === id);
      if (!note) return;
      setNotes((prev) => prev.filter((n) => n.id !== id));
      setTrash((prev) => [{ kind: 'note', id, deletedAt: Date.now(), note }, ...prev]);
    },
    [notes],
  );

  const deleteFolder = useCallback<NotesContextValue['deleteFolder']>(
    (id) => {
      const folder = folders.find((f) => f.id === id);
      if (!folder) return;
      // Trash the folder together with the notes it held, so a restore brings
      // the whole thing back.
      const folderNotes = notes.filter((note) => note.folderId === id);
      setNotes((prev) => prev.filter((note) => note.folderId !== id));
      setFolders((prev) => prev.filter((f) => f.id !== id));
      setTrash((prev) => [
        { kind: 'folder', id, deletedAt: Date.now(), folder, notes: folderNotes },
        ...prev,
      ]);
    },
    [folders, notes],
  );

  const restoreFromTrash = useCallback<NotesContextValue['restoreFromTrash']>(
    (entryId) => {
      const entry = trash.find((e) => e.id === entryId);
      if (!entry) return;
      if (entry.kind === 'note') {
        // If the note's folder is gone, restore it to the home screen instead.
        const folderExists =
          entry.note.folderId === null || folders.some((f) => f.id === entry.note.folderId);
        const note = folderExists ? entry.note : { ...entry.note, folderId: null };
        setNotes((prev) => [note, ...prev]);
      } else {
        setFolders((prev) => [entry.folder, ...prev]);
        setNotes((prev) => [...entry.notes, ...prev]);
      }
      setTrash((prev) => prev.filter((e) => e.id !== entryId));
    },
    [trash, folders],
  );

  const markNoteShared = useCallback<NotesContextValue['markNoteShared']>((id) => {
    setNotes((prev) => prev.map((note) => (note.id === id ? { ...note, shared: true } : note)));
  }, []);

  const toggleNoteFavorite = useCallback<NotesContextValue['toggleNoteFavorite']>((id) => {
    setNotes((prev) =>
      prev.map((note) => (note.id === id ? { ...note, favorite: !note.favorite } : note)),
    );
  }, []);

  const toggleFolderFavorite = useCallback<NotesContextValue['toggleFolderFavorite']>((id) => {
    setFolders((prev) =>
      prev.map((folder) => (folder.id === id ? { ...folder, favorite: !folder.favorite } : folder)),
    );
  }, []);

  const value = useMemo<NotesContextValue>(
    () => ({
      folders,
      notes,
      getFolder: (id) => folders.find((folder) => folder.id === id),
      getNote: (id) => notes.find((note) => note.id === id),
      getNotesInFolder: (folderId) => notes.filter((note) => note.folderId === folderId),
      getRootNotes: () => notes.filter((note) => note.folderId === null),
      createNote,
      createFolder,
      updateNote,
      updateFolder,
      moveNote,
      deleteNote,
      deleteFolder,
      toggleNoteFavorite,
      toggleFolderFavorite,
      markNoteShared,
      trash,
      restoreFromTrash,
    }),
    [
      folders,
      notes,
      trash,
      createNote,
      createFolder,
      updateNote,
      updateFolder,
      moveNote,
      deleteNote,
      deleteFolder,
      toggleNoteFavorite,
      toggleFolderFavorite,
      markNoteShared,
      restoreFromTrash,
    ],
  );

  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

export function useNotes(): NotesContextValue {
  const ctx = useContext(NotesContext);
  if (!ctx) throw new Error('useNotes must be used within a NotesProvider');
  return ctx;
}
