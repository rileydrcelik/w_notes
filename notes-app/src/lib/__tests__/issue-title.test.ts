/**
 * `stubIssueTitle` — the first-line stand-in an issue is saved with the moment
 * Create is pressed, before the model's title (if any) replaces it. See the
 * module doc atop `issue-title.ts` and `issue-retitle.ts`'s "THE STAND-IN IS
 * THE LOCK" note for why this string has to be exactly reproducible: the
 * retitle queue compares a row's *current* title against the stub it was
 * queued with to detect a hand rename, so any drift here (e.g. a differently
 * collapsed run of whitespace) would make every fresh issue look renamed
 * before the model ever answers.
 */
import { describe, expect, it, vi } from 'vitest';

import { STUB_TITLE_MAX, stubIssueTitle } from '@/lib/issue-title';

// `issue-title.ts` also exports `requestIssueTitle`, which imports
// `@/lib/sync/api` -> `@/lib/sentry` -> `@sentry/react-native`, pulling in real
// React Native internals that don't resolve under this node-environment
// vitest config (same issue `github-outbox.test.ts` documents). Mocking the
// module wholesale, the same way that file does, keeps this file's subject —
// `stubIssueTitle`, a pure string function — importable at all. `vi.mock` is
// hoisted above every import in the file regardless of where it's written, so
// this takes effect before the import above runs.
vi.mock('@/lib/sync/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
  apiFetch: vi.fn(),
}));

describe('stubIssueTitle', () => {
  it('takes the first line verbatim when it fits', () => {
    expect(stubIssueTitle('Fix the login bug\nSteps to reproduce...')).toBe('Fix the login bug');
  });

  it('skips leading blank lines to find the first non-blank one', () => {
    expect(stubIssueTitle('\n   \nThe real first line\nmore text')).toBe('The real first line');
  });

  it('returns an empty string for text that is entirely blank lines', () => {
    expect(stubIssueTitle('\n   \n\t\n')).toBe('');
  });

  it('collapses internal whitespace (tabs, repeated spaces) on the chosen line', () => {
    expect(stubIssueTitle('Fix   the\tlogin    bug')).toBe('Fix the login bug');
  });

  it('trims leading and trailing whitespace on the chosen line', () => {
    expect(stubIssueTitle('   Fix the login bug   \nmore')).toBe('Fix the login bug');
  });

  it('leaves a line exactly at the cap untouched', () => {
    const line = 'x'.repeat(STUB_TITLE_MAX);
    expect(stubIssueTitle(line)).toBe(line);
  });

  it('cuts an overlong line at a word boundary and appends an ellipsis', () => {
    const line = Array(30).fill('lorem').join(' '); // way past STUB_TITLE_MAX, has spaces throughout
    const result = stubIssueTitle(line);
    expect(result.endsWith('…')).toBe(true);
    // The cut must land on a word boundary: strip the ellipsis and the result
    // must be a prefix of the original line with no partial word glued to it.
    const withoutEllipsis = result.slice(0, -1);
    expect(line.startsWith(withoutEllipsis)).toBe(true);
    expect(line[withoutEllipsis.length]).toBe(' ');
  });

  it('does not cut off punctuation-then-space at the boundary — the cut is trimmed of trailing separators', () => {
    // Build a line whose word-boundary cut lands right after a comma.
    const line = 'a'.repeat(70) + ', ' + 'b'.repeat(70);
    const result = stubIssueTitle(line);
    expect(result.endsWith(', …')).toBe(false);
    expect(result.endsWith('…')).toBe(true);
  });

  it('backs up to a word boundary only when that keeps most of the line — one long word early on is cut hard rather than shrinking to a stub of a stub', () => {
    // One giant unbroken "word" that is itself far longer than STUB_TITLE_MAX,
    // with a single space near the very start. The only space in the first
    // STUB_TITLE_MAX chars is at index < STUB_TITLE_MAX / 2, so backing up to
    // it would throw away the vast majority of the line.
    const line = 'x ' + 'y'.repeat(200);
    const result = stubIssueTitle(line);
    // Backing up to the early space would yield just "x…" — that must NOT happen.
    expect(result).not.toBe('x…');
    // Instead the cut holds close to the full STUB_TITLE_MAX budget.
    const withoutEllipsis = result.slice(0, -1);
    expect(withoutEllipsis.length).toBeGreaterThan(STUB_TITLE_MAX / 2);
    expect(result.endsWith('…')).toBe(true);
  });

  it('is a pure function of the first line — later lines never affect the result', () => {
    const a = stubIssueTitle('Same first line\nA');
    const b = stubIssueTitle('Same first line\nCompletely different second line, much longer');
    expect(a).toBe(b);
  });
});
