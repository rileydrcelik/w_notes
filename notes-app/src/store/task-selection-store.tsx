import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type IdsHandler = (ids: string[]) => void;
type DoneHandler = (ids: string[], done: boolean) => void;

type TaskSelectionValue = {
  /** Whether issue-selection mode is active (a long-press/right-click turned it on). */
  active: boolean;
  /** Ids of the currently selected issues. */
  selectedIds: string[];
  count: number;
  isSelected: (id: string) => boolean;
  /** Toggle an issue; the first toggle also enters selection mode. */
  toggle: (id: string) => void;
  /** Exit selection mode and drop every selection. */
  clear: () => void;
  /** The project screen registers how "mark done / not done" applies; null on unmount. */
  registerMarkDoneHandler: (fn: DoneHandler | null) => void;
  /** The project screen registers what "edit attributes" opens; null on unmount. */
  registerEditAttrsHandler: (fn: IdsHandler | null) => void;
  /** The project screen registers what "delete" does; null on unmount. */
  registerDeleteHandler: (fn: IdsHandler | null) => void;
  /** Invoked by the navbar's Mark-done / Mark-not-done actions. */
  requestMarkDone: (done: boolean) => void;
  /** Invoked by the navbar's Edit-attributes action. */
  requestEditAttrs: () => void;
  /** Invoked by the navbar's Delete action. */
  requestDelete: () => void;
  /**
   * The project a mounted per-type issue screen belongs to, or null when none is
   * mounted. When set, the navbar's (+) opens the issue-creation screen for it.
   */
  composeProjectId: string | null;
  /** The issue-type the (+) composes into, paired with {@link composeProjectId}. */
  composeTypeId: string | null;
  /** A per-type screen sets/clears both ids here (null on unmount). */
  registerCompose: (projectId: string | null, typeId?: string | null) => void;
  /**
   * GitHub issue URL for the current selection when exactly one *mirrored* issue
   * is selected, else null. Drives the "Open on GitHub" row in the actions menu.
   */
  githubUrl: string | null;
  /** The per-type screen keeps this in sync with the selection (null when N/A). */
  registerGithubUrl: (url: string | null) => void;
};

const TaskSelectionContext = createContext<TaskSelectionValue | null>(null);

/**
 * Cross-tree state for the task-manager "select issues → act" flow and the
 * navbar's context-aware create button. Same pattern as
 * `github-selection-store` / `autofix-selection-store`: the project screen drives
 * selection + registers the action handlers, and the floating navbar reads this
 * to swap its (+) button (compose issue) and, while selecting, an actions menu.
 * Ephemeral (in memory only) — never touches the sync path.
 */
export function TaskSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const active = selectedIds.length > 0;

  const markDoneRef = useRef<DoneHandler | null>(null);
  const editAttrsRef = useRef<IdsHandler | null>(null);
  const deleteRef = useRef<IdsHandler | null>(null);
  const selectedRef = useRef<string[]>(selectedIds);
  selectedRef.current = selectedIds;

  const [composeProjectId, setComposeProjectId] = useState<string | null>(null);
  const [composeTypeId, setComposeTypeId] = useState<string | null>(null);
  const registerCompose = useCallback((projectId: string | null, typeId: string | null = null) => {
    setComposeProjectId(projectId);
    setComposeTypeId(projectId ? typeId : null);
  }, []);

  const [githubUrl, setGithubUrl] = useState<string | null>(null);
  const registerGithubUrl = useCallback((url: string | null) => setGithubUrl(url), []);

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);
  const clear = useCallback(() => setSelectedIds([]), []);

  const registerMarkDoneHandler = useCallback((fn: DoneHandler | null) => {
    markDoneRef.current = fn;
  }, []);
  const registerEditAttrsHandler = useCallback((fn: IdsHandler | null) => {
    editAttrsRef.current = fn;
  }, []);
  const registerDeleteHandler = useCallback((fn: IdsHandler | null) => {
    deleteRef.current = fn;
  }, []);

  const requestMarkDone = useCallback((done: boolean) => {
    const ids = selectedRef.current;
    if (ids.length > 0) markDoneRef.current?.(ids, done);
  }, []);
  const requestEditAttrs = useCallback(() => {
    const ids = selectedRef.current;
    if (ids.length > 0) editAttrsRef.current?.(ids);
  }, []);
  const requestDelete = useCallback(() => {
    const ids = selectedRef.current;
    if (ids.length > 0) deleteRef.current?.(ids);
  }, []);

  const isSelected = useCallback((id: string) => selectedIds.includes(id), [selectedIds]);

  const value = useMemo<TaskSelectionValue>(
    () => ({
      active,
      selectedIds,
      count: selectedIds.length,
      isSelected,
      toggle,
      clear,
      registerMarkDoneHandler,
      registerEditAttrsHandler,
      registerDeleteHandler,
      requestMarkDone,
      requestEditAttrs,
      requestDelete,
      composeProjectId,
      composeTypeId,
      registerCompose,
      githubUrl,
      registerGithubUrl,
    }),
    [
      active,
      selectedIds,
      isSelected,
      toggle,
      clear,
      registerMarkDoneHandler,
      registerEditAttrsHandler,
      registerDeleteHandler,
      requestMarkDone,
      requestEditAttrs,
      requestDelete,
      composeProjectId,
      composeTypeId,
      registerCompose,
      githubUrl,
      registerGithubUrl,
    ],
  );

  return <TaskSelectionContext.Provider value={value}>{children}</TaskSelectionContext.Provider>;
}

export function useTaskSelection(): TaskSelectionValue {
  const ctx = useContext(TaskSelectionContext);
  if (!ctx) throw new Error('useTaskSelection must be used within a TaskSelectionProvider');
  return ctx;
}
