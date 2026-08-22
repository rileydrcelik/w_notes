/**
 * The master resume: the superset document a folder's other resumes are tailored
 * from.
 *
 * Scoped to a folder rather than to the account, because a person applying for
 * two different kinds of work has two different supersets — a backend folder and
 * a data-science folder each have their own, and tailoring inside one has no
 * business starting from the other's.
 *
 * ## Where the pointer lives, and why that settles the hard part
 *
 * In the folder's own `config` JSON, under `masterResumeId`. The interesting
 * consequence is that "exactly one master per folder" stops being an invariant
 * anyone has to enforce: there is one folder row, holding one key, so there is
 * nowhere for a second master to live. Two devices offline naming different
 * masters is then the same conflict as two devices renaming the same folder —
 * one row, last writer wins, both converge on the next sync. A boolean on each
 * *note* would have been the version that breaks: two notes are two rows, both
 * writes succeed independently, and the account ends up with two masters and
 * nothing in the sync protocol able to notice.
 *
 * `config` is also already in `_PRESERVE_IF_NULL` on the server
 * (`backend/app/routers/sync.py`), so an older build that doesn't know about
 * this key cannot null it out by syncing — which is the failure that made
 * `notes.published` need that machinery in the first place.
 *
 * Resumes on the home screen have no folder and therefore no master. That is a
 * real gap and not worth closing by inventing a pseudo-folder for the root:
 * tailoring such a note behaves exactly as it did before this existed.
 */
import type { Folder, Note } from '@/data/notes';
import { isResumeNote } from '@/lib/resume-note';

/**
 * The note id this folder calls its master, or `null` for none.
 *
 * Unrecognised or corrupt config reads as `null` rather than throwing, matching
 * `resumeEnginePreference` — a folder written by a newer build should fall back
 * to "no master chosen", not break the screen it is rendered on.
 */
export function folderMasterResumeId(folder: Pick<Folder, 'config'>): string | null {
  if (!folder.config) return null;
  try {
    const parsed = JSON.parse(folder.config) as { masterResumeId?: unknown };
    if (typeof parsed?.masterResumeId === 'string' && parsed.masterResumeId) {
      return parsed.masterResumeId;
    }
  } catch {
    // A corrupt config reads as "no master".
  }
  return null;
}

/**
 * `config` with the master set, or cleared for `null`.
 *
 * Every other key is copied through untouched. This matters more here than
 * anywhere else in the app: a project folder's `config` holds its repo and its
 * whole attribute schema, and a resume folder that happened to also be a project
 * would lose all of it to an object rebuilt from scratch. The finance sheet
 * learned this one expensively; `resumeConfigWithEngine` is the same shape.
 */
export function folderConfigWithMaster(
  folder: Pick<Folder, 'config'>,
  noteId: string | null,
): string {
  let config: Record<string, unknown> = {};
  if (folder.config) {
    try {
      const parsed = JSON.parse(folder.config) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // A corrupt config is replaced rather than propagated.
    }
  }
  if (noteId === null) delete config.masterResumeId;
  else config.masterResumeId = noteId;
  return JSON.stringify(config);
}

/**
 * The master resume for the folder a note lives in, or `null`.
 *
 * The pointer is resolved rather than trusted, and every way it can dangle is
 * treated as "no master" instead of as an error:
 *
 * - the note is on the home screen, so there is no folder to hold one;
 * - the folder names a note this device hasn't synced yet — folders and notes
 *   arrive in independently-paged sync batches, so a pointer legitimately
 *   precedes its target, and this is a transient state rather than corruption;
 * - the named note has been trashed, or has stopped being a resume;
 * - the named note has been moved to a different folder, which nothing clears
 *   the pointer on, because doing so would mean every note move had to search
 *   every folder that might name it.
 *
 * A trashed master keeps its pointer on purpose: restoring the note brings the
 * designation back with it, which is what "trash is reversible" ought to mean.
 */
export function masterResumeFor(
  note: Pick<Note, 'folderId'>,
  folders: Pick<Folder, 'id' | 'config'>[],
  notes: Note[],
): Note | null {
  if (!note.folderId) return null;
  const folder = folders.find((f) => f.id === note.folderId);
  if (!folder) return null;
  const masterId = folderMasterResumeId(folder);
  if (!masterId) return null;
  const master = notes.find((n) => n.id === masterId);
  if (!master || !isResumeNote(master)) return null;
  return master.folderId === note.folderId ? master : null;
}

/** Whether this note is the master of the folder it lives in. */
export function isMasterResume(
  note: Pick<Note, 'id' | 'folderId'>,
  folders: Pick<Folder, 'id' | 'config'>[],
): boolean {
  if (!note.folderId) return false;
  const folder = folders.find((f) => f.id === note.folderId);
  return !!folder && folderMasterResumeId(folder) === note.id;
}
