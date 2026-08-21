/**
 * Walking the folder tree: what a folder contains, and where it may be moved.
 *
 * Pure — no React, no database — so the rule that keeps the tree a tree can be
 * tested directly, the way `lib/issue-cascade.ts` is. Two callers rely on it:
 * deleting a folder (which takes its whole subtree down together) and moving one
 * (which must not be allowed to swallow itself).
 *
 * The rule worth stating plainly: **a folder can never be moved inside itself or
 * inside anything it contains.** Allowing it would detach that subtree from the
 * root entirely — a cycle has no path back to Home, so the folder and everything
 * under it would still exist, still sync, and appear on no screen on any device.
 * That is silent data loss, and the sort that survives a reinstall, so the guard
 * lives here where it can be tested rather than only in the UI that offers the
 * destinations.
 */
import type { Folder } from '@/data/notes';

/** Just the parent link — all this module needs of a folder. */
export type FolderNode = Pick<Folder, 'id' | 'parentId'>;

/**
 * `rootId` plus every folder beneath it, at any depth.
 *
 * Iterates to a fixed point rather than recursing: `folders` arrives in whatever
 * order the store holds it (a child can precede its parent), and a corrupt
 * parent link that formed a cycle would send a naive recursion into an infinite
 * loop. Growing a set is indifferent to order and terminates either way.
 */
export function folderSubtreeIds(folders: FolderNode[], rootId: string): Set<string> {
  const subtree = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId && subtree.has(folder.parentId) && !subtree.has(folder.id)) {
        subtree.add(folder.id);
        grew = true;
      }
    }
  }
  return subtree;
}

/**
 * The folders that may not receive `movingIds` — each moving folder and its
 * descendants. Home (`null`) is always a legal destination and never appears
 * here.
 *
 * Note what is *not* excluded: the folder a moving item already sits in. Moving
 * something to where it already is is a no-op, not an error, and hiding the row
 * would make the sheet's checkmark point at a destination you can't see.
 */
export function invalidMoveTargets(folders: FolderNode[], movingIds: string[]): Set<string> {
  const blocked = new Set<string>();
  for (const id of movingIds) {
    for (const descendant of folderSubtreeIds(folders, id)) blocked.add(descendant);
  }
  return blocked;
}

/**
 * Whether `folderId` may be moved into `destinationId` (`null` = Home).
 *
 * The last line of defence, for the store: the sheet already filters the
 * destinations it offers, but a move that forms a cycle is unrecoverable through
 * the UI, so the write path checks rather than trusts its caller.
 */
export function canMoveFolder(
  folders: FolderNode[],
  folderId: string,
  destinationId: string | null,
): boolean {
  if (destinationId === null) return true;
  if (destinationId === folderId) return false;
  return !folderSubtreeIds(folders, folderId).has(destinationId);
}
