/**
 * Where a note or folder opens, and whether it belongs in a list of notes at
 * all.
 *
 * A note's `pluginType` decides its screen: a finance note is a spreadsheet, a
 * resume is LaTeX source, a github/sentry note is live remote content. Opening
 * any of them in the plain text editor is not a cosmetic mistake — a resume's
 * body is LaTeX, and `lib/resume-note.ts` exists precisely to keep that string
 * away from the rich-text renderer.
 *
 * This lives here rather than inside the note cards because the cards each know
 * their own single type, and a surface rendering a *mixed* list has nothing to
 * read. The right sidebar had no answer and sent every note to `/note/[id]`,
 * which is the bug this module exists to stop recurring: anything listing notes
 * of more than one kind routes through here.
 */
import type { ComponentProps } from 'react';
import type Feather from '@expo/vector-icons/Feather';
import type { Href } from 'expo-router';

import type { Folder, Note } from '@/data/notes';

type FeatherName = ComponentProps<typeof Feather>['name'];

/**
 * Whether a note should appear in a list of the user's notes.
 *
 * `issuetype` notes are the task manager's machinery — one per issue type in a
 * project, holding that type's definition. They are notes only in the storage
 * sense; the project screen lists them as types in their own UI and filters them
 * out of its notes (see `app/(home)/project/[id].tsx`). Anywhere else they read
 * as notes the user never made.
 */
export function isListableNote(note: Pick<Note, 'pluginType'>): boolean {
  return note.pluginType !== 'issuetype';
}

/** The screen that opens this note, by plugin type. */
export function noteHref(note: Pick<Note, 'id' | 'pluginType'>): Href {
  const params = { id: note.id };
  switch (note.pluginType) {
    case 'finance':
      return { pathname: '/finance/[id]', params };
    case 'resume':
      return { pathname: '/resume/[id]', params };
    case 'sentry':
      return { pathname: '/sentry/[id]', params };
    case 'github':
      return { pathname: '/github/[id]', params };
    // An issuetype note has no screen of its own — it's reached through its
    // project. Callers should have filtered it out via `isListableNote`; sending
    // it to the text editor is the least-worst fallback if one slips through.
    default:
      return { pathname: '/note/[id]', params };
  }
}

/**
 * The screen that opens this folder. A project is a folder in storage but an
 * issue tracker on screen, and its children are issue types rather than notes —
 * so it opens its own screen instead of listing what's inside it.
 */
export function folderHref(folder: Pick<Folder, 'id' | 'kind'>): Href {
  return folder.kind === 'project'
    ? { pathname: '/project/[id]', params: { id: folder.id } }
    : { pathname: '/folder/[id]', params: { id: folder.id } };
}

/** The icon that marks this note's kind, matching the note cards. */
export function noteIcon(note: Pick<Note, 'pluginType'>): FeatherName {
  switch (note.pluginType) {
    case 'finance':
      return 'grid';
    case 'sentry':
      return 'alert-triangle';
    case 'github':
      return 'github';
    default:
      return 'file-text';
  }
}
