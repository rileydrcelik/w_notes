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
import { db } from '@/lib/db';
import { isDbLockedError } from '@/lib/web-db-lock';
import { requestSync, subscribeSynced, syncNow } from '@/lib/sync/sync-engine';
import { effectiveTypeIds, type Issue, type IssueAttrValue } from '@/data/notes';

const today = () => new Date().toISOString().slice(0, 10);

const rid = () => `issue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Display order within a type: incomplete issues first (oldest → newest), then
 * completed issues (newest → oldest). Enforced here so it holds regardless of
 * how issues landed in the store (DB load, optimistic create, or sync pull).
 */
const orderIssues = (list: Issue[]): Issue[] =>
  [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1; // incomplete before complete
    return a.done ? b.createdAt - a.createdAt : a.createdAt - b.createdAt;
  });

/** Optimistic write-through: report failures to Sentry and schedule a sync. */
const persist = (write: Promise<unknown>) => {
  write.catch((e) => {
    if (isDbLockedError(e)) return;
    Sentry.captureException(e, { tags: { source: 'issues-store' } });
  });
  requestSync();
};

type IssuePatch = {
  title?: string;
  description?: string;
  noteId?: string;
  typeIds?: string[];
  done?: boolean;
  attrs?: Record<string, IssueAttrValue>;
  ghNumber?: number | null;
  position?: number;
};

type IssuesContextValue = {
  issues: Issue[];
  /** True once the initial load from SQLite has completed (guards GitHub back-
   *  sync from treating a not-yet-loaded store as "no issues" and re-importing). */
  hydrated: boolean;
  /** Live issues filed under a given issue-type note (matches any of its types). */
  getIssuesForNote: (noteId: string) => Issue[];
  /** Creates an issue under one or more type-notes and returns its id. */
  createIssue: (input: {
    noteId: string;
    typeIds?: string[];
    title: string;
    description?: string;
    attrs?: Record<string, IssueAttrValue>;
    ghNumber?: number;
  }) => string;
  updateIssue: (id: string, patch: IssuePatch) => void;
  /** Sets the done flag (the "mark as done" action). */
  setDone: (id: string, done: boolean) => void;
  /** Flips the done flag (double-tap / undo). */
  toggleDone: (id: string) => void;
  deleteIssue: (id: string) => void;
};

const IssuesContext = createContext<IssuesContextValue | null>(null);

/**
 * Holds the live issues for every task-manager project. Mirrors the notes store:
 * hydrates from on-device SQLite on mount, applies every mutation optimistically
 * and writes it through to SQLite (which the sync engine then pushes), and
 * refreshes when a sync pulls remote changes.
 */
export function IssuesProvider({ children }: { children: ReactNode }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [hydrated, setHydrated] = useState(false);

  const reload = useCallback(async () => {
    try {
      const rows = await db.getIssues();
      setIssues(rows);
      setHydrated(true);
    } catch (e) {
      if (isDbLockedError(e)) return;
      console.warn('[issues] failed to load from device:', e);
      Sentry.captureException(e, { tags: { source: 'issues-store', op: 'load' } });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async hydrate
    void reload();
  }, [reload]);

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

  const createIssue = useCallback<IssuesContextValue['createIssue']>((input) => {
    const id = rid();
    // Default to the single home type when no explicit set is given.
    const typeIds = input.typeIds ?? (input.noteId ? [input.noteId] : []);
    const issue: Issue = {
      id,
      noteId: input.noteId,
      typeIds,
      title: input.title,
      description: input.description ?? '',
      done: false,
      attrs: input.attrs ?? {},
      ghNumber: input.ghNumber,
      position: 0,
      createdAt: Date.now(),
      updatedAt: today(),
    };
    // Order is enforced at read time (orderIssues in getIssuesForNote), so the
    // insert position here is irrelevant — append and let the sort place it.
    setIssues((prev) => [...prev, issue]);
    persist(
      db.createIssue({
        id,
        noteId: input.noteId,
        typeIds,
        title: input.title,
        description: input.description,
        attrs: input.attrs,
        ghNumber: input.ghNumber,
      }),
    );
    return id;
  }, []);

  const updateIssue = useCallback<IssuesContextValue['updateIssue']>((id, patch) => {
    setIssues((prev) =>
      prev.map((i) =>
        i.id === id
          ? {
              ...i,
              ...patch,
              // Normalize a cleared gh_number (null) back to undefined for the app shape.
              ghNumber: patch.ghNumber === null ? undefined : patch.ghNumber ?? i.ghNumber,
              updatedAt: today(),
            }
          : i,
      ),
    );
    persist(db.updateIssue(id, patch));
  }, []);

  const setDone = useCallback<IssuesContextValue['setDone']>(
    (id, done) => updateIssue(id, { done }),
    [updateIssue],
  );

  const toggleDone = useCallback<IssuesContextValue['toggleDone']>(
    (id) => {
      setIssues((prev) => {
        const current = prev.find((i) => i.id === id);
        if (current) persist(db.updateIssue(id, { done: !current.done }));
        return prev.map((i) => (i.id === id ? { ...i, done: !i.done, updatedAt: today() } : i));
      });
    },
    [],
  );

  const deleteIssue = useCallback<IssuesContextValue['deleteIssue']>((id) => {
    setIssues((prev) => prev.filter((i) => i.id !== id));
    persist(db.deleteIssue(id));
  }, []);

  const getIssuesForNote = useCallback(
    (noteId: string) => orderIssues(issues.filter((i) => effectiveTypeIds(i).includes(noteId))),
    [issues],
  );

  const value = useMemo<IssuesContextValue>(
    () => ({
      issues,
      hydrated,
      getIssuesForNote,
      createIssue,
      updateIssue,
      setDone,
      toggleDone,
      deleteIssue,
    }),
    [issues, hydrated, getIssuesForNote, createIssue, updateIssue, setDone, toggleDone, deleteIssue],
  );

  return <IssuesContext.Provider value={value}>{children}</IssuesContext.Provider>;
}

export function useIssues(): IssuesContextValue {
  const ctx = useContext(IssuesContext);
  if (!ctx) throw new Error('useIssues must be used within an IssuesProvider');
  return ctx;
}
