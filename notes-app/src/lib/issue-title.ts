/**
 * An issue's title, from the one field the New issue screen asks for.
 *
 * What was typed becomes the description word for word; the title is derived.
 * It starts as a stand-in cut from the first line — so the issue has a name the
 * instant it's saved, online or not — and the model's title replaces it when
 * `POST /issues/title` answers (see `lib/issue-retitle.ts`).
 */
import { ApiError, apiFetch } from '@/lib/sync/api';

/** Longest stand-in title, before the ellipsis. */
export const STUB_TITLE_MAX = 80;

/**
 * The first non-blank line, whitespace collapsed, cut at a word boundary when
 * it's too long to read as a title.
 */
export function stubIssueTitle(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .find(Boolean) ?? '';
  if (line.length <= STUB_TITLE_MAX) return line;
  const cut = line.slice(0, STUB_TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  // Only back up to a space that leaves most of the line; one long word early on
  // would otherwise shrink the title to a stub of a stub.
  const kept = space > STUB_TITLE_MAX / 2 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:-]+$/, '')}…`;
}

/** Ask the server to name this text. Rejects with `ApiError` on a refusal. */
export async function requestIssueTitle(text: string): Promise<string> {
  const res = await apiFetch<{ title?: unknown }>('/issues/title', {
    method: 'POST',
    body: { text },
  });
  const title = typeof res.title === 'string' ? res.title.trim() : '';
  // A 200 with no title is the server misbehaving, which is worth another try
  // later — hence a 5xx rather than a status the queue gives up on.
  if (!title) throw new ApiError('The title service returned an empty title.', 502);
  return title;
}
