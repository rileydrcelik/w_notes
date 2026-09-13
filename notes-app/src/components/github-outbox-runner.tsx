/**
 * Drives both GitHub queues: replays pushes that were held back while offline,
 * and files issues composed on a plugin note while there was no connection.
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
import { db } from '@/lib/db';
import {
  flushGithubOutbox,
  loadGithubOutbox,
  pushOrQueue,
  setGithubOutboxDeps,
  type OutboxDeps,
} from '@/lib/github-outbox';
import { flushGithubDrafts, loadGithubDrafts } from '@/lib/github-issue-drafts';
import { updateGithubIssue } from '@/lib/issue-github';
import {
  flushIssueRetitles,
  isRetitlePending,
  loadIssueRetitles,
  type RetitleDeps,
} from '@/lib/issue-retitle';
import { ISSUE_TYPE_PLUGIN, parseTypeConfig, projectConfig } from '@/lib/project';
import { Sentry } from '@/lib/sentry';
import { subscribeSyncSuccess } from '@/lib/sync/sync-engine';
import { useIssues } from '@/store/issues-store';
import { useNotes } from '@/store/notes-store';

export function GithubOutboxRunner() {
  const { updateIssue, applyTitleIfStub } = useIssues();
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

  const retitleDepsRef = useRef<RetitleDeps | null>(null);

  useEffect(() => {
    const deps: OutboxDeps = {
      resolve,
      setGhNumber: (issueId, ghNumber) => updateIssue(issueId, { ghNumber }),
      holdCreate: isRetitlePending,
    };
    depsRef.current = deps;
    // So the New issue screen can flush the create it just queued.
    setGithubOutboxDeps(deps);
    retitleDepsRef.current = {
      applyTitle: applyTitleIfStub,
      // An issue already mirrored under its stand-in title gets the real one
      // pushed. One not mirrored yet needs nothing: its queued create reads the
      // row at replay time, and this flush runs first.
      onRetitled: async (issueId, title) => {
        const row = await db.getIssueById(issueId);
        const number = row?.ghNumber;
        if (!row || number == null) return;
        const ctx = resolve(row);
        const repo = ctx?.repo;
        if (!repo || !ctx.connected) return;
        const r = await pushOrQueue({
          issueId,
          repo,
          facets: { title: true },
          push: () => updateGithubIssue(repo, number, { title }),
        });
        if (r.status === 'failed') {
          Sentry.addBreadcrumb({
            category: 'issue-retitle',
            message: `title not pushed to GitHub for ${issueId}: ${r.message}`,
            level: 'warning',
          });
        }
      },
    };
    return () => setGithubOutboxDeps(null);
  }, [resolve, updateIssue, applyTitleIfStub]);

  useEffect(() => {
    void loadGithubOutbox();
    void loadGithubDrafts();
    void loadIssueRetitles();
  }, []);

  useEffect(
    () =>
      subscribeSyncSuccess(() => {
        const deps = depsRef.current;
        const retitleDeps = retitleDepsRef.current;
        if (!deps || !retitleDeps) return;
        // Titles first, so a create that was queued offline replays with the
        // model's title rather than the stand-in. A title that can't get through
        // must not hold the pushes back, hence `finally`.
        void flushIssueRetitles(retitleDeps)
          .catch((e) => {
            Sentry.captureException(e, { tags: { source: 'issue-retitle', op: 'runner' } });
          })
          .finally(() =>
            flushGithubOutbox(deps).catch((e) => {
              Sentry.captureException(e, { tags: { source: 'github-outbox', op: 'runner' } });
            }),
          );
      }),
    [],
  );

  // Its own subscription rather than a branch inside the one above: the two
  // queues fail independently, and a refusal replaying an intent must not stop
  // a composed issue going out (or the reverse). Neither needs the stores, so
  // this one takes no deps.
  useEffect(
    () =>
      subscribeSyncSuccess(() => {
        void flushGithubDrafts().catch((e) => {
          Sentry.captureException(e, { tags: { source: 'github-drafts', op: 'runner' } });
        });
      }),
    [],
  );

  return null;
}
