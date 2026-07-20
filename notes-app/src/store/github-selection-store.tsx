import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import type { CreatedIssue } from '@/lib/github-note';

/** Why an issue was closed — GitHub's `state_reason` for the close action. */
export type CloseReason = 'completed' | 'not_planned';

type IdsHandler = (ids: string[]) => void;
type CloseHandler = (ids: string[], reason: CloseReason) => void;
type CommentHandler = (ids: string[], body: string) => void;

type GithubSelectionValue = {
  /** Whether issue-selection mode is active (a long-press/right-click turned it on). */
  active: boolean;
  /** Ids (issue numbers, as strings) of the currently selected issues. */
  selectedIds: string[];
  /** Convenience count of `selectedIds`. */
  count: number;
  isSelected: (id: string) => boolean;
  /** Toggle an issue; the first toggle also enters selection mode. */
  toggle: (id: string) => void;
  /** Exit selection mode and drop every selection. */
  clear: () => void;
  /** The GitHub screen registers what "Close" does (with a reason); null on unmount. */
  registerCloseHandler: (fn: CloseHandler | null) => void;
  /** The GitHub screen registers what "Reopen" does; null on unmount. */
  registerReopenHandler: (fn: IdsHandler | null) => void;
  /** The GitHub screen registers what "Comment" does (with body text); null on unmount. */
  registerCommentHandler: (fn: CommentHandler | null) => void;
  /** The GitHub screen registers what "Copy" does; null on unmount. */
  registerCopyHandler: (fn: IdsHandler | null) => void;
  /** Invoked by the navbar's Close action — closes the selection with a reason. */
  requestClose: (reason: CloseReason) => void;
  /** Invoked by the navbar's Reopen action — reopens the selected issues. */
  requestReopen: () => void;
  /** Invoked by the navbar's Comment action — posts `body` to the selection. */
  requestComment: (body: string) => void;
  /** Invoked by the navbar's Copy action — copies the selected issues' links/details. */
  requestCopy: () => void;
  /**
   * The repo a configured GitHub issues screen is showing, or null when no such
   * screen is mounted. When set, the navbar's create (+) button opens the issue
   * composer for this repo instead of the new-note menu.
   */
  composeRepo: string | null;
  /** The GitHub screen sets/clears its repo here (null on unmount/unconfigured). */
  registerComposeRepo: (repo: string | null) => void;
  /** The GitHub screen registers how a newly-created issue is applied; null on unmount. */
  registerCreatedHandler: (fn: ((issue: CreatedIssue) => void) | null) => void;
  /** Invoked by the composer (rendered in the navbar) when an issue is created. */
  emitCreated: (issue: CreatedIssue) => void;
};

const GithubSelectionContext = createContext<GithubSelectionValue | null>(null);

/**
 * Cross-tree state for the GitHub issues "select → act" flow. The GitHub issues
 * screen drives the selection (long-press/right-click), while the global floating
 * navbar reads it to swap its create (+) button for a selection-actions button.
 * Lifting it here (rather than into the screen) is what lets those two distant
 * components talk — the same pattern as `autofix-selection-store`, kept separate
 * so the Sentry flow stays untouched.
 *
 * Selection is intentionally ephemeral (in memory only): it never touches the
 * SQLite/sync path, matching how plugin issue data is live/on-demand elsewhere.
 */
export function GithubSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Selection mode is purely a function of whether anything is selected — so
  // deselecting the last issue automatically drops back to normal (tap-to-expand)
  // mode rather than getting stuck in an empty selection.
  const active = selectedIds.length > 0;
  // Refs so registering/replacing a handler never re-renders consumers, and so
  // the `request*` callbacks stay stable.
  const closeHandlerRef = useRef<CloseHandler | null>(null);
  const reopenHandlerRef = useRef<IdsHandler | null>(null);
  const commentHandlerRef = useRef<CommentHandler | null>(null);
  const copyHandlerRef = useRef<IdsHandler | null>(null);
  // Mirror the selection into a ref so the request callbacks read the latest
  // without being recreated on every toggle.
  const selectedRef = useRef<string[]>(selectedIds);
  selectedRef.current = selectedIds;

  // The composer target repo (reactive — the navbar swaps its (+) behavior on
  // it) plus a ref to the screen's "issue created" handler.
  const [composeRepo, setComposeRepo] = useState<string | null>(null);
  const createdHandlerRef = useRef<((issue: CreatedIssue) => void) | null>(null);
  const registerComposeRepo = useCallback((repo: string | null) => setComposeRepo(repo), []);
  const registerCreatedHandler = useCallback(
    (fn: ((issue: CreatedIssue) => void) | null) => {
      createdHandlerRef.current = fn;
    },
    [],
  );
  const emitCreated = useCallback((issue: CreatedIssue) => createdHandlerRef.current?.(issue), []);

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const clear = useCallback(() => setSelectedIds([]), []);

  const registerCloseHandler = useCallback((fn: CloseHandler | null) => {
    closeHandlerRef.current = fn;
  }, []);
  const registerReopenHandler = useCallback((fn: IdsHandler | null) => {
    reopenHandlerRef.current = fn;
  }, []);
  const registerCommentHandler = useCallback((fn: CommentHandler | null) => {
    commentHandlerRef.current = fn;
  }, []);
  const registerCopyHandler = useCallback((fn: IdsHandler | null) => {
    copyHandlerRef.current = fn;
  }, []);

  const requestClose = useCallback((reason: CloseReason) => {
    const ids = selectedRef.current;
    if (ids.length > 0) closeHandlerRef.current?.(ids, reason);
  }, []);
  const requestReopen = useCallback(() => {
    const ids = selectedRef.current;
    if (ids.length > 0) reopenHandlerRef.current?.(ids);
  }, []);
  const requestComment = useCallback((body: string) => {
    const ids = selectedRef.current;
    if (ids.length > 0 && body.trim()) commentHandlerRef.current?.(ids, body.trim());
  }, []);
  const requestCopy = useCallback(() => {
    const ids = selectedRef.current;
    if (ids.length > 0) copyHandlerRef.current?.(ids);
  }, []);

  const isSelected = useCallback((id: string) => selectedIds.includes(id), [selectedIds]);

  const value = useMemo<GithubSelectionValue>(
    () => ({
      active,
      selectedIds,
      count: selectedIds.length,
      isSelected,
      toggle,
      clear,
      registerCloseHandler,
      registerReopenHandler,
      registerCommentHandler,
      registerCopyHandler,
      requestClose,
      requestReopen,
      requestComment,
      requestCopy,
      composeRepo,
      registerComposeRepo,
      registerCreatedHandler,
      emitCreated,
    }),
    [
      active,
      selectedIds,
      isSelected,
      toggle,
      clear,
      registerCloseHandler,
      registerReopenHandler,
      registerCommentHandler,
      registerCopyHandler,
      requestClose,
      requestReopen,
      requestComment,
      requestCopy,
      composeRepo,
      registerComposeRepo,
      registerCreatedHandler,
      emitCreated,
    ],
  );

  return (
    <GithubSelectionContext.Provider value={value}>{children}</GithubSelectionContext.Provider>
  );
}

export function useGithubSelection(): GithubSelectionValue {
  const ctx = useContext(GithubSelectionContext);
  if (!ctx) throw new Error('useGithubSelection must be used within a GithubSelectionProvider');
  return ctx;
}
