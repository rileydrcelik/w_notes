import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { seedFolders, seedNotes, type Folder, type Note } from '@/data/notes';

const today = () => new Date().toISOString().slice(0, 10);

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
    }),
    [folders, notes, createNote, createFolder, updateNote, updateFolder],
  );

  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

export function useNotes(): NotesContextValue {
  const ctx = useContext(NotesContext);
  if (!ctx) throw new Error('useNotes must be used within a NotesProvider');
  return ctx;
}
