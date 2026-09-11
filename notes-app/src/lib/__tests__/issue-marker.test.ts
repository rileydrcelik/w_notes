/**
 * Round-trip tests for the managed id marker in `issue-github.ts`.
 *
 * These import the REAL module, unlike github-outbox.test.ts and
 * github-backsync.test.ts which mock `@/lib/issue-github` wholesale. That
 * wholesale mock is right for those suites — they are testing the callers — but
 * it means the marker's own parsing had no coverage anywhere, and it shipped
 * broken once already: the char class was written `[^<>s]`, excluding the letter
 * "s" rather than whitespace, so it matched no real id at all (every id from
 * `rid()` looks like `issue-<ts>-<rand>`). Nothing went red, because nothing
 * executed it.
 *
 * Only `@/lib/sync/api` needs stubbing — it is the module's single runtime
 * import, and it reaches @sentry/react-native, which doesn't resolve under the
 * node-env vitest config.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  githubIssueBody,
  githubIssueDescription,
  markedIssueId,
  upsertAttrsBlock,
} from '@/lib/issue-github';

// Below the imports, not above: vitest hoists the factory above every import
// at transform time regardless, so this still applies (same pattern as
// github-backsync.test.ts).
vi.mock('@/lib/sync/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
  apiFetch: vi.fn(),
}));

/** A realistic local id — `rid()` mints `issue-<ts>-<rand>`, so it has an "s". */
const ID = 'issue-1712345678901-a9f3kd';

describe('issue id marker', () => {
  it('round-trips a realistic issue id through a created body', () => {
    const body = githubIssueBody('Some description', [], {}, ID);
    expect(body).toContain('Some description');
    expect(markedIssueId(body)).toBe(ID);
  });

  it('marks a body that has no description at all', () => {
    const body = githubIssueBody(undefined, [], {}, ID);
    expect(markedIssueId(body)).toBe(ID);
  });

  it('keeps the marker out of the description read back from GitHub', () => {
    const body = githubIssueBody('Just the prose', [], {}, ID);
    expect(githubIssueDescription(body)).toBe('Just the prose');
  });

  it('carries the marker across an attribute-block rewrite', () => {
    const body = githubIssueBody('Prose', [], {}, ID);
    const rewritten = upsertAttrsBlock(body, [], {});
    expect(markedIssueId(rewritten)).toBe(ID);
    expect(rewritten).toContain('Prose');
  });

  it('does not accumulate a second marker when rewritten repeatedly', () => {
    let body = githubIssueBody('Prose', [], {}, ID) ?? '';
    for (let i = 0; i < 3; i += 1) body = upsertAttrsBlock(body, [], {}, ID);
    expect(body.match(/w-notes:issue:/g)).toHaveLength(1);
    expect(markedIssueId(body)).toBe(ID);
  });

  it('returns null for a body with no marker', () => {
    expect(markedIssueId('plain text')).toBeNull();
    expect(markedIssueId('')).toBeNull();
    expect(markedIssueId(null)).toBeNull();
  });

  it('ignores an unterminated marker prefix rather than reading past it', () => {
    // A user pasting the opening half into a body must not make the parser
    // swallow the real marker that follows.
    const body = `<!-- w-notes:issue:truncated\n\n${'<!-- w-notes:issue:' + ID + ' -->'}`;
    expect(markedIssueId(body)).toBe(ID);
  });
});
