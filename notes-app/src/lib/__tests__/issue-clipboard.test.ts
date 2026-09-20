/**
 * `issueToClipboardText` — what the copy button on an issue card writes.
 *
 * The case that matters is the title-only issue. Body-only copying (2026-09-15
 * to 2026-09-20) handed those an empty string, which on web cleared the
 * clipboard and on native did nothing, while the button flashed a checkmark
 * regardless. See the module doc atop `issue-clipboard.ts`.
 *
 * Pure function, no mocking needed: `@/data/notes` only exports plain types and
 * two id helpers, none of which touch anything native.
 */
import { describe, expect, it } from 'vitest';

import type { Issue } from '@/data/notes';
import { issueToClipboardText } from '@/lib/issue-clipboard';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'i0',
    noteId: 't1',
    typeIds: ['t1'],
    title: '',
    description: '',
    done: false,
    attrs: {},
    position: 0,
    createdAt: 0,
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

describe('issueToClipboardText', () => {
  it('copies the body, and only the body, when there is one', () => {
    const issue = makeIssue({
      title: 'Export crashes',
      description: 'Tapping export on a cold start throws.',
    });

    expect(issueToClipboardText(issue)).toBe('Tapping export on a cold start throws.');
  });

  it('falls back to the title when the issue has no body', () => {
    const issue = makeIssue({ title: 'Export crashes', description: '' });

    expect(issueToClipboardText(issue)).toBe('Export crashes');
  });

  it('falls back to the title when the body is only whitespace', () => {
    const issue = makeIssue({ title: 'Export crashes', description: '  \n\t ' });

    expect(issueToClipboardText(issue)).toBe('Export crashes');
  });

  it('trims the body rather than pasting the editor’s trailing newlines', () => {
    const issue = makeIssue({ title: 'Export crashes', description: '\n Line one \n' });

    expect(issueToClipboardText(issue)).toBe('Line one');
  });

  it('is empty only when the issue has neither body nor title', () => {
    expect(issueToClipboardText(makeIssue())).toBe('');
  });
});
