import { useCallback, useEffect, useRef, useState } from 'react';

import type { ResumeVersion } from '@/data/notes';
import { db } from '@/lib/db';
import { sortVersionsNewestFirst } from '@/lib/resume-versions';
import { Sentry } from '@/lib/sentry';
import { requestSync, subscribeSynced } from '@/lib/sync/sync-engine';
import { isDbLockedError } from '@/lib/web-db-lock';

const vid = () => `ver-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * One resume's version history, and the one way to add to it.
 *
 * A hook rather than a context store — unlike notes, folders and issues, a
 * resume's history is only ever wanted by the screen showing that resume, so
 * there's nothing to share app-wide and nothing else to keep in step. It reloads
 * after a sync so history written on another device appears without a revisit.
 */
export function useResumeVersions(noteId: string): {
  versions: ResumeVersion[];
  /**
   * Start a new version holding `source`, and resolve its id — or `null` if the
   * write failed.
   *
   * **Callers about to overwrite the live document must wait for an id**, because
   * until this lands the text being replaced exists in only one place.
   */
  append: (label: string, source: string, createdAt?: number) => Promise<string | null>;
  /**
   * Keep a version in step with the editor. Silent on failure: this fires on a
   * debounce as someone types, and the note's own body is committed separately,
   * so a missed update costs the version freshness rather than the document.
   */
  update: (id: string, source: string) => Promise<void>;
  /** Drop a version from the history, on every device. */
  remove: (id: string) => Promise<boolean>;
  /**
   * Whether this resume has no history yet — i.e. the next snapshot taken will be
   * its original.
   *
   * A function reading a ref, not `versions.length`, because the callers that need
   * it ask *after* an await that can run for minutes (tailoring), and a value
   * captured in a closure before that await can be stale by the time it is read: a
   * sync landing mid-request would leave a second snapshot labelled as "the
   * original". The ref is refreshed by every reload, which happens after each
   * append and after each sync.
   */
  isEmpty: () => boolean;
} {
  const [versions, setVersions] = useState<ResumeVersion[]>([]);
  // The same list, readable without going through a closure. See `isEmpty`.
  const latest = useRef<ResumeVersion[]>([]);

  const reload = useCallback(async () => {
    if (!noteId) return;
    try {
      const rows = await db.listResumeVersions(noteId);
      const ordered = sortVersionsNewestFirst(rows);
      latest.current = ordered;
      setVersions(ordered);
    } catch (e) {
      // A locked database on web is a transient condition another tab causes;
      // the next sync tick reloads. Anything else is worth knowing about.
      if (!isDbLockedError(e)) {
        Sentry.captureException(e, { tags: { source: 'resume-versions' } });
      }
    }
  }, [noteId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async load
    void reload();
  }, [reload]);

  // History from another device arrives via sync, not through this screen.
  useEffect(() => subscribeSynced(() => void reload()), [reload]);

  const append = useCallback(
    async (label: string, source: string, createdAt?: number): Promise<string | null> => {
      if (!noteId) return null;
      const id = vid();
      try {
        await db.createResumeVersion({ id, noteId, label, source, createdAt });
      } catch (e) {
        if (!isDbLockedError(e)) {
          Sentry.captureException(e, { tags: { source: 'resume-versions' } });
        }
        return null;
      }
      await reload();
      requestSync();
      return id;
    },
    [noteId, reload],
  );

  const update = useCallback(
    async (id: string, source: string): Promise<void> => {
      if (!id) return;
      try {
        await db.updateResumeVersion(id, source);
      } catch (e) {
        if (!isDbLockedError(e)) {
          Sentry.captureException(e, { tags: { source: 'resume-versions' } });
        }
        return;
      }
      // Keeps `latest` honest for `isEmpty`, and the list correct if it is open.
      await reload();
      requestSync();
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await db.deleteResumeVersion(id);
      } catch (e) {
        if (!isDbLockedError(e)) {
          Sentry.captureException(e, { tags: { source: 'resume-versions' } });
        }
        return false;
      }
      await reload();
      requestSync();
      return true;
    },
    [reload],
  );

  const isEmpty = useCallback(() => latest.current.length === 0, []);

  return { versions, append, update, remove, isEmpty };
}
