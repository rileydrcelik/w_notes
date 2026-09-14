/**
 * What a project folder card claims it holds. See `lib/issue-counts.ts` for why
 * a project's total is not the sum of its types' totals.
 */
import { describe, expect, it } from 'vitest';

import {
  countIssuesInTypes,
  indexActiveIssuesByType,
  type CountableIssue,
} from '@/lib/issue-counts';

const issue = (id: string, noteId: string, typeIds: string[] = []): CountableIssue => ({
  id,
  noteId,
  typeIds,
  done: false,
});

const done = (id: string, noteId: string, typeIds: string[] = []): CountableIssue => ({
  ...issue(id, noteId, typeIds),
  done: true,
});

const count = (issues: CountableIssue[], typeIds: string[]) =>
  countIssuesInTypes(indexActiveIssuesByType(issues), typeIds);

describe('countIssuesInTypes', () => {
  it('counts the issues under a single type', () => {
    expect(count([issue('i1', 'bug'), issue('i2', 'bug')], ['bug'])).toBe(2);
  });

  it('adds up across the types a project holds', () => {
    expect(count([issue('i1', 'bug'), issue('i2', 'chore')], ['bug', 'chore'])).toBe(2);
  });

  it('counts an issue in two of those types once, not twice', () => {
    // The reason this isn't a sum of per-type totals. Adding them would say 2.
    expect(count([issue('i1', 'bug', ['bug', 'chore'])], ['bug', 'chore'])).toBe(1);
  });

  it('still counts an issue whose only listed type is one of these', () => {
    expect(count([issue('i1', 'bug', ['bug', 'chore'])], ['chore'])).toBe(1);
  });

  it('falls back to the primary type when type_ids is empty', () => {
    // Rows written before multi-type membership carry only `note_id`.
    expect(count([issue('i1', 'bug')], ['bug'])).toBe(1);
  });

  it('ignores issues belonging to another project entirely', () => {
    expect(count([issue('i1', 'other')], ['bug'])).toBe(0);
  });

  it('is zero for a project with no types yet', () => {
    expect(count([issue('i1', 'bug')], [])).toBe(0);
  });

  it('is zero for a tracker with no issues yet', () => {
    expect(count([], ['bug'])).toBe(0);
  });

  it('does not count a type twice when it is asked for twice', () => {
    expect(count([issue('i1', 'bug')], ['bug', 'bug'])).toBe(1);
  });

  it('leaves out an issue that is already done', () => {
    expect(count([issue('i1', 'bug'), done('i2', 'bug')], ['bug'])).toBe(1);
  });

  it('is zero once every issue in the project is done', () => {
    expect(count([done('i1', 'bug'), done('i2', 'chore')], ['bug', 'chore'])).toBe(0);
  });

  it('leaves out a done issue from every type it was filed under', () => {
    expect(count([done('i1', 'bug', ['bug', 'chore'])], ['chore'])).toBe(0);
  });
});

describe('indexActiveIssuesByType', () => {
  it('files an issue under every type it belongs to', () => {
    const index = indexActiveIssuesByType([issue('i1', 'bug', ['bug', 'chore'])]);
    expect(index.get('bug')).toEqual(new Set(['i1']));
    expect(index.get('chore')).toEqual(new Set(['i1']));
  });

  it('is built once and answers for every project — no entry for an unused type', () => {
    const index = indexActiveIssuesByType([issue('i1', 'bug')]);
    expect(index.get('chore')).toBeUndefined();
  });

  it('never files a done issue, so nothing downstream can count it', () => {
    const index = indexActiveIssuesByType([done('i1', 'bug')]);
    expect(index.get('bug')).toBeUndefined();
  });
});
