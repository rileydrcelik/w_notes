/**
 * Drives the GitHub outbox: replays pushes that were held back while offline.
 *
 * Renders nothing. It is mounted in the app shell rather than on a screen
 * because that is the whole point — a push queued on the New issue screen has to
 * go out whether or not anyone is looking at that project, and the screen that
 * queued it called `router.back()` a moment later. Sitting inside the providers
 * gives the flush the notes/issues stores it needs to rebuild a request, which
 * a bare module could not reach without duplicating the DB reads behind them.
 *
 * The retry signal is a completed sync pass (see `subscribeSyncSuccess`), not a
 * network-reachability check: the GitHub proxy rides the same base URL, bearer
 * and CORS rules as sync, so a pass that came back proves precisely the
 * preconditions a push needs.
 */
import { useCallback, useEffect, useRef } from 'react';

import { effectiveTypeIds, type Issue, type Note } from '@/data/notes';
import { flushGithubOutbox, loadGithubOutbox, type OutboxDeps } from '@/lib/github-outbox';
import { ISSUE_TYPE_PLUGIN, parseTypeConfig, projectConfig } from '@/lib/project';
import { Sentry } from '@/lib/sentry';
import { subscribeSyncSuccess } from '@/lib/sync/sync-engine';
import { useIssues } from '@/store/issues-store';
import { useNotes } from '@/store/notes-store';

export function GithubOutboxRunner() {
  const { updateIssue } = useIssues();
  const { getNote, getFolder, getNotesInFolder } = useNotes();

  // The latest store readers live in a ref so the subscription installs once and
  // never re-subscribes as notes change — the same shape the project feed uses
  // to keep its back-sync callback stable.
  const depsRef = useRef<OutboxDeps | null>(null);

  const resolve = useCallback<OutboxDeps['resolve']>(
    (issue: Issue) => {
      // An issue is filed under type-notes; they share a project folder, which
      // holds the repo and the attribute schema.
      //
      // Anchored on the first *live* type rather than on `noteId`. The delete
      // cascade spares an issue that still has another live type without
      // rewriting its noteId, so the primary can sit in the trash while the
      // issue itself is perfectly alive — and anchoring on it would abandon a
      // queued push for an issue the user can still see.
      const ownTypes = effectiveTypeIds(issue)
        .map((tid) => getNote(tid))
        .filter((n): n is Note => !!n && n.pluginType === ISSUE_TYPE_PLUGIN);
      const anchor = ownTypes[0];
      const folderId = anchor?.folderId;
      if (!folderId) return null;
      const folder = getFolder(folderId);
      if (!folder) return null;
      const config = projectConfig(folder);
      if (!config) return null;

      // Only *live* type notes count. The delete cascade leaves a trashed type's
      // id in `typeIds` for an issue that survived under another type, so going
      // straight from `effectiveTypeIds` to labels would push a label for a type
      // sitting in the trash.
      const liveTypes = getNotesInFolder(folderId).filter((n) => n.pluginType === ISSUE_TYPE_PLUGIN);
      const typeTitles = ownTypes.map((t) => t.title);

      return {
        repo: config.repo,
        attributes: config.attributes,
        typeTitles,
        // Project-wide, not the issue's own: `isManagedLabel` recognises a label
        // only by matching a known type name, so a narrower list would treat the
        // label of a type the issue was removed from as somebody else's and
        // leave it on the GitHub issue for ever.
        projectTypeNames: liveTypes.map((t) => t.title),
        // Any live type being tracked is enough. Backfilling a newly-tracked
        // type queues issues whose *primary* type is a different, untracked one,
        // and gating on the primary would have made the offline path drop
        // exactly the issues the online path happily opens.
        connected: ownTypes.some((t) => parseTypeConfig(t.pluginConfig).githubConnected),
      };
    },
    [getNote, getFolder, getNotesInFolder],
  );

  useEffect(() => {
    depsRef.current = {
      resolve,
      setGhNumber: (issueId, ghNumber) => updateIssue(issueId, { ghNumber }),
    };
  }, [resolve, updateIssue]);

  useEffect(() => {
    void loadGithubOutbox();
  }, []);

  useEffect(
    () =>
      subscribeSyncSuccess(() => {
        const deps = depsRef.current;
        if (!deps) return;
        void flushGithubOutbox(deps).catch((e) => {
          Sentry.captureException(e, { tags: { source: 'github-outbox', op: 'runner' } });
        });
      }),
    [],
  );

  return null;
}
