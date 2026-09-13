/**
 * Coverage for `githubToAttrs` in `issue-github.ts` — the pull-side inverse of
 * `githubIssueBody`/`upsertAttrsBlock`. Before this change only `builtin`
 * attributes (the seeded Status/People/Priority) were filled from GitHub; the
 * `builtin` flag is gone now and every `people` attribute is filled from
 * `assignees`, and every `select`/`stars` attribute from the managed
 * `<!-- w-notes:attributes -->` table, matched case-insensitively on the
 * attribute's `name`. A custom (formerly non-builtin) attribute is exactly the
 * case that regresses if that flag check ever comes back.
 *
 * Only `@/lib/sync/api` needs stubbing — same reason as issue-marker.test.ts:
 * it's issue-github.ts's one runtime import, and it reaches
 * @sentry/react-native, which doesn't resolve under the node-env vitest
 * config.
 */
import { describe, expect, it, vi } from 'vitest';

import { githubIssueBody, githubToAttrs } from '@/lib/issue-github';
import type { AttrDef } from '@/lib/project';
import type { IssueAttrValue } from '@/data/notes';

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

const STATUS: AttrDef = { id: 'status', name: 'Status', type: 'select', options: ['Todo', 'Done'] };
const PRIORITY: AttrDef = { id: 'priority', name: 'Priority', type: 'stars' };
const PEOPLE: AttrDef = { id: 'people', name: 'People', type: 'people' };
/** A custom, user-authored attribute — the case that never got back-synced
 *  before `builtin` was removed. */
const SEVERITY: AttrDef = { id: 'sev', name: 'Severity', type: 'select', options: ['Low', 'High'] };

const ATTRS: AttrDef[] = [STATUS, PRIORITY, PEOPLE, SEVERITY];

describe('githubToAttrs', () => {
  it('round-trips select, stars, people and a custom attribute through githubIssueBody', () => {
    const values: Record<string, IssueAttrValue> = {
      status: 'Done',
      priority: 3,
      people: ['alice', 'bob'],
      sev: 'High',
    };
    const body = githubIssueBody('Some description', ATTRS, values);
    const result = githubToAttrs(ATTRS, body, values.people as string[], {});
    expect(result).toEqual(values);
  });

  it('clears an attribute whose row is missing from an otherwise-present block', () => {
    // Block present (Status set), but Priority and Severity were never set —
    // so they get no row at all. A pull must clear them from `existing`.
    const body = githubIssueBody('desc', ATTRS, { status: 'Todo' });
    const existing: Record<string, IssueAttrValue> = { status: 'Done', priority: 4, sev: 'Low' };
    const result = githubToAttrs(ATTRS, body, [], existing);
    expect(result.status).toBe('Todo');
    expect(result.priority).toBeUndefined();
    expect(result.sev).toBeUndefined();
  });

  it('leaves select/stars values untouched when the body has no managed block at all', () => {
    const existing: Record<string, IssueAttrValue> = { status: 'Done', priority: 2, sev: 'High' };
    const result = githubToAttrs(ATTRS, 'Just a plain user-written body, no markers.', [], existing);
    expect(result.status).toBe('Done');
    expect(result.priority).toBe(2);
    expect(result.sev).toBe('High');
  });

  it('deletes the people value when assignees is empty, replaces it when present', () => {
    const cleared = githubToAttrs([PEOPLE], null, [], { people: ['alice'] });
    expect(cleared.people).toBeUndefined();

    const replaced = githubToAttrs([PEOPLE], null, ['carol', 'dave'], { people: ['alice'] });
    expect(replaced.people).toEqual(['carol', 'dave']);
  });

  it('parses stars from a repeated ★ and from a bare number, clamped to 5', () => {
    const starBody = [
      '<!-- w-notes:attributes -->',
      '| Attribute | Value |',
      '| --- | --- |',
      '| Priority | ★★★ |',
      '<!-- /w-notes:attributes -->',
    ].join('\n');
    expect(githubToAttrs([PRIORITY], starBody, [], {}).priority).toBe(3);

    const numberBody = [
      '<!-- w-notes:attributes -->',
      '| Attribute | Value |',
      '| --- | --- |',
      '| Priority | 9 |',
      '<!-- /w-notes:attributes -->',
    ].join('\n');
    expect(githubToAttrs([PRIORITY], numberBody, [], {}).priority).toBe(5);
  });

  it('matches attribute names case-insensitively', () => {
    const body = [
      '<!-- w-notes:attributes -->',
      '| Attribute | Value |',
      '| --- | --- |',
      '| severity | High |',
      '<!-- /w-notes:attributes -->',
    ].join('\n');
    expect(githubToAttrs([SEVERITY], body, [], {}).sev).toBe('High');
  });

  it('round-trips a value containing an escaped pipe', () => {
    const value = 'Blocked | needs review';
    const body = githubIssueBody('desc', [SEVERITY], { sev: value });
    expect(githubToAttrs([SEVERITY], body, [], {}).sev).toBe(value);
  });
});
