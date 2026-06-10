import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { db, type TrashEntry } from '@/lib/db';
import type { Folder, Note } from '@/data/notes';

const today = () => new Date().toISOString().slice(0, 10);

// Re-exported so existing imports (`import { type TrashEntry } from '@/store/notes-store'`)
// keep working now that the canonical definition lives in the db module.
export type { TrashEntry };

const rid = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Logs a failed background sync without disturbing the optimistic UI. */
const syncFailed = (e: unknown) => console.warn('[notes] background sync failed:', e);

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
 * Holds the live, editable notes and folders. On mount it hydrates from
 * on-device SQLite; every mutation updates local state immediately (optimistic)
 * and writes through to SQLite in the background, so the UI stays instant while
 * changes are durably persisted on the device.
 */
export function NotesProvider({ children }: { children: ReactNode }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [trash, setTrash] = useState<TrashEntry[]>([]);

  // Hydrate from the API once on mount.
  useEffect(() => {
    let cancelled = false;
    db
      .bootstrap()
      .then((data) => {
        if (cancelled) return;
        setNotes(data.notes);
        setFolders(data.folders);
        setTrash(data.trash);
      })
      .catch((e) => console.warn('[notes] failed to load from API:', e));
    return () => {
      cancelled = true;
    };
  }, []);

  const createNote = useCallback<NotesContextValue['createNote']>((folderId) => {
    const id = rid('note');
    const note: Note = { id, title: '', body: '', folderId, updatedAt: today() };
    // Prepend so the new note surfaces first in its location.
    setNotes((prev) => [note, ...prev]);
    db.createNote({ id, folderId }).catch(syncFailed);
    return id;
  }, []);

  const createFolder = useCallback<NotesContextValue['createFolder']>(() => {
    const id = rid('folder');
    // Prepend so the new folder surfaces first in the hierarchy.
    setFolders((prev) => [{ id, name: '' }, ...prev]);
    db.createFolder({ id }).catch(syncFailed);
    return id;
  }, []);

  const updateNote = useCallback<NotesContextValue['updateNote']>((id, patch) => {
    setNotes((prev) =>
      prev.map((note) => (note.id === id ? { ...note, ...patch, updatedAt: today() } : note)),
    );
    db.updateNote(id, patch).catch(syncFailed);
  }, []);

  const updateFolder = useCallback<NotesContextValue['updateFolder']>((id, patch) => {
    setFolders((prev) => prev.map((folder) => (folder.id === id ? { ...folder, ...patch } : folder)));
    db.updateFolder(id, patch).catch(syncFailed);
  }, []);

  const moveNote = useCallback<NotesContextValue['moveNote']>((id, folderId) => {
    setNotes((prev) =>
      prev.map((note) => (note.id === id ? { ...note, folderId, updatedAt: today() } : note)),
    );
    db.updateNote(id, { folderId }).catch(syncFailed);
  }, []);

  const deleteNote = useCallback<NotesContextValue['deleteNote']>(
    (id) => {
      const note = notes.find((n) => n.id === id);
      if (!note) return;
      setNotes((prev) => prev.filter((n) => n.id !== id));
      setTrash((prev) => [{ kind: 'note', id, deletedAt: Date.now(), note }, ...prev]);
      db.deleteNote(id).catch(syncFailed);
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
      db.deleteFolder(id).catch(syncFailed);
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
      db.restoreFromTrash(entryId).catch(syncFailed);
    },
    [trash, folders],
  );

  const markNoteShared = useCallback<NotesContextValue['markNoteShared']>((id) => {
    setNotes((prev) => prev.map((note) => (note.id === id ? { ...note, shared: true } : note)));
    db.updateNote(id, { shared: true }).catch(syncFailed);
  }, []);

  const toggleNoteFavorite = useCallback<NotesContextValue['toggleNoteFavorite']>(
    (id) => {
      const next = !notes.find((n) => n.id === id)?.favorite;
      setNotes((prev) =>
        prev.map((note) => (note.id === id ? { ...note, favorite: next } : note)),
      );
      db.updateNote(id, { favorite: next }).catch(syncFailed);
    },
    [notes],
  );

  const toggleFolderFavorite = useCallback<NotesContextValue['toggleFolderFavorite']>(
    (id) => {
      const next = !folders.find((f) => f.id === id)?.favorite;
      setFolders((prev) =>
        prev.map((folder) => (folder.id === id ? { ...folder, favorite: next } : folder)),
      );
      db.updateFolder(id, { favorite: next }).catch(syncFailed);
    },
    [folders],
  );

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
