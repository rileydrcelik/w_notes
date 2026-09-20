/**
 * An issue as pasteable text, for the copy button on an issue card.
 *
 * What you get is the body, word for word and nothing else — the point of the
 * button is to hand the issue's text to something else (a chat, a commit
 * message, a model), and a "Title\n\n" header is noise there.
 *
 * THE TITLE IS THE FALLBACK, NOT A HEADER. Most issues are written as a title
 * with no body at all — the card only renders a description when there is one —
 * and body-only copying meant those wrote an *empty string* to the clipboard:
 * on web that silently cleared it (paste gave blank), on native it was a no-op,
 * while the button flashed its checkmark either way. So an issue with no body
 * copies its title instead. Copy never produces nothing.
 */
import type { Issue } from '@/data/notes';

/**
 * The issue's body, or its title when it has no body. Empty only when the issue
 * has neither, which the caller treats as nothing to copy rather than writing a
 * blank over whatever is on the clipboard.
 */
export function issueToClipboardText(issue: Issue): string {
  return issue.description.trim() || issue.title.trim();
}
