import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { Sentry } from '@/lib/sentry';
import { db, type TrashEntry } from '@/lib/db';
import { isDbLockedError } from '@/lib/web-db-lock';
import { requestSync, subscribeSynced, syncNow } from '@/lib/sync/sync-engine';
import type { Folder, Note } from '@/data/notes';

const today = () => new Date().toISOString().slice(0, 10);

// Re-exported so existing imports (`import { type TrashEntry } from '@/store/notes-store'`)
// keep working now that the canonical definition lives in the db module.
export type { TrashEntry };

const rid = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Reports a failed background persist/sync without disturbing the optimistic UI.
 * The write already failed silently to the user (state was updated optimistically),
 * so this is the only place it surfaces: a console warning for dev plus a Sentry
 * capture (with the db breadcrumbs attached) for visibility in production.
 */
const syncFailed = (e: unknown) => {
  console.warn('[notes] background sync failed:', e);
  Sentry.captureException(e, { tags: { source: 'notes-store' } });
};

/**
 * Persist a write optimistically: report failures to Sentry and schedule a
 * (debounced) sync so the change propagates to the backend. Module-scoped so it
 * isn't a hook dependency.
 */
const persist = (write: Promise<unknown>) => {
  write.catch(syncFailed);
  requestSync();
};

type NotesContextValue = {
  folders: Folder[];
  notes: Note[];
  getFolder: (id: string) => Folder | undefined;
  getNote: (id: string) => Note | undefined;
  getNotesInFolder: (folderId: string) => Note[];
  getRootNotes: () => Note[];
  /** Folders that live on the home screen (no parent). */
  getRootFolders: () => Folder[];
  /** Folders nested directly inside the given folder. */
  getSubfolders: (parentId: string) => Folder[];
  /** Creates an empty note in the given folder (null = root) and returns its id. */
  createNote: (folderId: string | null) => string;
  /** Creates an unnamed folder inside the given parent (null = root); returns its id. */
  createFolder: (parentId: string | null) => string;
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

  // Re-read the whole slice from SQLite. Used to hydrate on mount and to refresh
  // after a sync pulls remote changes into the database.
  const reload = useCallback(async () => {
    try {
      const data = await db.bootstrap();
      setNotes(data.notes);
      setFolders(data.folders);
      setTrash(data.trash);
    } catch (e) {
      // A follower browser tab can't open the OPFS database (another tab owns it);
      // the DbTabGuard handles that case, so don't report it as an error.
      if (isDbLockedError(e)) return;
      console.warn('[notes] failed to load from device:', e);
      Sentry.captureException(e, { tags: { source: 'notes-store', op: 'bootstrap' } });
    }
  }, []);

  // Hydrate on mount, then kick a first sync. (reload sets state only after an
  // await, so this isn't a synchronous-setState-in-effect despite the lint rule.)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async hydrate
    void reload().then(() => syncNow().catch(() => {}));
  }, [reload]);

  // Refresh when a sync applies remote changes, and sync on app foreground.
  useEffect(() => {
    const unsub = subscribeSynced(() => void reload());
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void syncNow().catch(() => {});
    });
    return () => {
      unsub();
      sub.remove();
    };
  }, [reload]);

  const createNote = useCallback<NotesContextValue['createNote']>((folderId) => {
    const id = rid('note');
    const note: Note = { id, title: '', body: '', folderId, updatedAt: today() };
    // Prepend so the new note surfaces first in its location.
    setNotes((prev) => [note, ...prev]);
    persist(db.createNote({ id, folderId }));
    return id;
  }, []);

  const createFolder = useCallback<NotesContextValue['createFolder']>((parentId) => {
    const id = rid('folder');
    // Prepend so the new folder surfaces first in the hierarchy.
    setFolders((prev) => [{ id, name: '', parentId }, ...prev]);
    persist(db.createFolder({ id, parentId }));
    return id;
  }, []);

  const updateNote = useCallback<NotesContextValue['updateNote']>((id, patch) => {
    setNotes((prev) =>
      prev.map((note) => (note.id === id ? { ...note, ...patch, updatedAt: today() } : note)),
    );
    persist(db.updateNote(id, patch));
  }, []);

  const updateFolder = useCallback<NotesContextValue['updateFolder']>((id, patch) => {
    setFolders((prev) => prev.map((folder) => (folder.id === id ? { ...folder, ...patch } : folder)));
    persist(db.updateFolder(id, patch));
  }, []);

  const moveNote = useCallback<NotesContextValue['moveNote']>((id, folderId) => {
    setNotes((prev) =>
      prev.map((note) => (note.id === id ? { ...note, folderId, updatedAt: today() } : note)),
    );
    persist(db.updateNote(id, { folderId }));
  }, []);

  const deleteNote = useCallback<NotesContextValue['deleteNote']>(
    (id) => {
      const note = notes.find((n) => n.id === id);
      if (!note) return;
      setNotes((prev) => prev.filter((n) => n.id !== id));
      setTrash((prev) => [{ kind: 'note', id, deletedAt: Date.now(), note }, ...prev]);
      persist(db.deleteNote(id));
    },
    [notes],
  );

  const deleteFolder = useCallback<NotesContextValue['deleteFolder']>(
    (id) => {
      const folder = folders.find((f) => f.id === id);
      if (!folder) return;
      // Gather the whole subtree (this folder + every descendant folder) so the
      // delete cascades and a restore brings the entire group back together.
      const subtreeIds = new Set<string>([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of folders) {
          if (f.parentId && subtreeIds.has(f.parentId) && !subtreeIds.has(f.id)) {
            subtreeIds.add(f.id);
            grew = true;
          }
        }
      }
      const descendantFolders = folders.filter((f) => f.id !== id && subtreeIds.has(f.id));
      const subtreeNotes = notes.filter((note) => note.folderId && subtreeIds.has(note.folderId));

      setNotes((prev) => prev.filter((note) => !(note.folderId && subtreeIds.has(note.folderId))));
      setFolders((prev) => prev.filter((f) => !subtreeIds.has(f.id)));
      setTrash((prev) => [
        {
          kind: 'folder',
          id,
          deletedAt: Date.now(),
          folder,
          folders: descendantFolders,
          notes: subtreeNotes,
        },
        ...prev,
      ]);
      persist(db.deleteFolder(id));
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
        // Reattach the root folder to its parent, or to home if that parent is
        // gone; the rest of the subtree comes back unchanged around it.
        const parentExists =
          entry.folder.parentId === null || folders.some((f) => f.id === entry.folder.parentId);
        const folder = parentExists ? entry.folder : { ...entry.folder, parentId: null };
        setFolders((prev) => [folder, ...entry.folders, ...prev]);
        setNotes((prev) => [...entry.notes, ...prev]);
      }
      setTrash((prev) => prev.filter((e) => e.id !== entryId));
      persist(db.restoreFromTrash(entryId));
    },
    [trash, folders],
  );

  const markNoteShared = useCallback<NotesContextValue['markNoteShared']>((id) => {
    setNotes((prev) => prev.map((note) => (note.id === id ? { ...note, shared: true } : note)));
    persist(db.updateNote(id, { shared: true }));
  }, []);

  const toggleNoteFavorite = useCallback<NotesContextValue['toggleNoteFavorite']>(
    (id) => {
      const next = !notes.find((n) => n.id === id)?.favorite;
      setNotes((prev) =>
        prev.map((note) => (note.id === id ? { ...note, favorite: next } : note)),
      );
      persist(db.updateNote(id, { favorite: next }));
    },
    [notes],
  );

  const toggleFolderFavorite = useCallback<NotesContextValue['toggleFolderFavorite']>(
    (id) => {
      const next = !folders.find((f) => f.id === id)?.favorite;
      setFolders((prev) =>
        prev.map((folder) => (folder.id === id ? { ...folder, favorite: next } : folder)),
      );
      persist(db.updateFolder(id, { favorite: next }));
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
      getRootFolders: () => folders.filter((folder) => folder.parentId == null),
      getSubfolders: (parentId) => folders.filter((folder) => folder.parentId === parentId),
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
