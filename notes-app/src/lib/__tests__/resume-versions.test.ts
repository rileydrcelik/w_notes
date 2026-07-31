import { describe, expect, it } from 'vitest';

import type { ResumeVersion } from '@/data/notes';
import {
  MAX_LABEL_CHARS,
  describeAge,
  describeTailorTarget,
  isOriginal,
  originalLabel,
  resolveAddLabel,
  resolveEditLabel,
  matchesVersionSearch,
  sortVersionsNewestFirst,
  truncateLabel,
} from '@/lib/resume-versions';

const version = (id: string, createdAt: number, label = id): ResumeVersion => ({
  id,
  noteId: 'note-1',
  label,
  source: `source-${id}`,
  createdAt,
});

describe('truncateLabel', () => {
  it('leaves a short label alone', () => {
    expect(truncateLabel('Added Backend Engineer, Globex')).toBe(
      'Added Backend Engineer, Globex',
    );
  });

  it('collapses newlines, so a multi-line instruction fits one row', () => {
    expect(truncateLabel('rewrite this\n  and\tthat')).toBe('rewrite this and that');
  });

  it('cuts on a word boundary and marks the cut', () => {
    const result = truncateLabel('alpha bravo charlie delta echo foxtrot', 20);
    expect(result).toBe('alpha bravo charlie…');
    // The ellipsis is allowed to put it one over; what matters is it doesn't run.
    expect(result.length).toBeLessThanOrEqual(21);
  });

  it('cuts mid-word when a single word is longer than the cap', () => {
    // No boundary to fall back to, so it has to cut inside the word rather than
    // return an empty label.
    expect(truncateLabel('Supercalifragilisticexpialidocious', 10)).toBe('Supercalif…');
  });

  it('ignores a word boundary that would throw away more than half', () => {
    // Cutting at the space would leave "a" — technically a word boundary, and a
    // useless label. Better to cut inside the long word.
    expect(truncateLabel('a verylongsingletokenhere', 12)).toBe('a verylongsi…');
  });

  it('defaults to the cap the backend uses', () => {
    expect(MAX_LABEL_CHARS).toBe(80);
    const long = 'x'.repeat(200);
    expect(truncateLabel(long).length).toBe(MAX_LABEL_CHARS + 1);
  });
});

describe('originalLabel', () => {
  it('is the resume title', () => {
    expect(originalLabel({ title: 'Steve — Backend' })).toBe('Steve — Backend');
  });

  it('falls back to the same name an untitled resume has everywhere else', () => {
    expect(originalLabel({ title: '   ' })).toBe('Untitled resume');
  });
});

describe('resolveAddLabel', () => {
  it('prefers the model summary', () => {
    expect(resolveAddLabel('  Added Platform Engineer, Initech  ', { title: 'x', subtitle: 'y' })).toBe(
      'Added Platform Engineer, Initech',
    );
  });

  it('builds title + subtitle when the summary is empty', () => {
    expect(resolveAddLabel('', { title: 'Backend Engineer', subtitle: 'Globex' })).toBe(
      'Added Backend Engineer, Globex',
    );
  });

  it('omits an absent subtitle rather than trailing a comma', () => {
    expect(resolveAddLabel('', { title: 'MSc Computer Science', subtitle: '  ' })).toBe(
      'Added MSc Computer Science',
    );
  });

  it('still says something when the form gives it nothing', () => {
    expect(resolveAddLabel('', { title: '', subtitle: '' })).toBe('Added an entry');
  });
});

describe('resolveEditLabel', () => {
  it('prefers the model summary', () => {
    expect(resolveEditLabel('Reworded the billing bullet', { instructions: 'whatever' })).toBe(
      'Reworded the billing bullet',
    );
  });

  it('falls back to what the person asked for', () => {
    expect(resolveEditLabel('', { instructions: 'add a bullet about Postgres' })).toBe(
      'add a bullet about Postgres',
    );
  });

  it('still says something when both are empty', () => {
    expect(resolveEditLabel('   ', { instructions: '  ' })).toBe('Edited an entry');
  });
});

describe('describeTailorTarget', () => {
  it('is the company and the role, and nothing else', () => {
    expect(describeTailorTarget({ company: 'Acme', role: 'Senior Backend Engineer' })).toBe(
      'Acme — Senior Backend Engineer',
    );
  });

  it('drops an absent company rather than leading with a separator', () => {
    expect(describeTailorTarget({ company: '  ', role: 'Data Engineer' })).toBe('Data Engineer');
  });

  it('drops an absent role rather than trailing a separator', () => {
    expect(describeTailorTarget({ company: 'Acme', role: '  ' })).toBe('Acme');
  });

  it('still names itself when neither is given', () => {
    expect(describeTailorTarget({ company: '', role: '' })).toBe('Tailored resume');
  });

  it('truncates a company that pasted the whole posting header', () => {
    const label = describeTailorTarget({ company: 'A'.repeat(200), role: 'Engineer' });
    expect(label.length).toBeLessThanOrEqual(MAX_LABEL_CHARS + 1);
  });
});

describe('matchesVersionSearch', () => {
  const v = (label: string, source = '') => ({ label, source });

  it('matches everything when nothing is typed', () => {
    expect(matchesVersionSearch(v('Tailored for Acme'), '')).toBe(true);
    expect(matchesVersionSearch(v('Tailored for Acme'), '   ')).toBe(true);
  });

  it('matches the label, case-insensitively in both directions', () => {
    expect(matchesVersionSearch(v('Tailored for Acme'), 'acme')).toBe(true);
    // The query is lowercased too, not just the text being searched.
    expect(matchesVersionSearch(v('Tailored for Acme'), 'ACME')).toBe(true);
    expect(matchesVersionSearch(v('tailored for acme'), 'Acme')).toBe(true);
    expect(matchesVersionSearch(v('Tailored for Acme'), 'globex')).toBe(false);
  });

  it('matches the document text too', () => {
    // The other real question about a history: which version still had this in it.
    const version = v('Tailored for Acme', String.raw`
esumeItem{Postgres partitioning}`);
    expect(matchesVersionSearch(version, 'postgres')).toBe(true);
  });

  it('requires every term, in any order', () => {
    const version = v('Tailored for Acme, Senior Backend Engineer');
    expect(matchesVersionSearch(version, 'acme backend')).toBe(true);
    expect(matchesVersionSearch(version, 'backend acme')).toBe(true);
    expect(matchesVersionSearch(version, 'acme frontend')).toBe(false);
  });

  it('does not match a term spanning the label/source join', () => {
    // They are joined for searching; a query must not match across the seam.
    expect(matchesVersionSearch(v('abc', 'def'), 'abcdef')).toBe(false);
  });
});

describe('sortVersionsNewestFirst', () => {
  it('puts the newest first', () => {
    const sorted = sortVersionsNewestFirst([version('a', 100), version('c', 300), version('b', 200)]);
    expect(sorted.map((v) => v.id)).toEqual(['c', 'b', 'a']);
  });

  it('breaks a same-millisecond tie deterministically', () => {
    // One action writes two snapshots, and they can land in the same millisecond.
    // Without a tiebreak the order would be whatever the input happened to be —
    // so feeding both orders must produce the same answer.
    const one = sortVersionsNewestFirst([version('aaa', 5), version('bbb', 5)]);
    const other = sortVersionsNewestFirst([version('bbb', 5), version('aaa', 5)]);
    expect(one.map((v) => v.id)).toEqual(other.map((v) => v.id));
  });

  it('does not mutate its input', () => {
    const input = [version('a', 100), version('b', 200)];
    sortVersionsNewestFirst(input);
    expect(input.map((v) => v.id)).toEqual(['a', 'b']);
  });

  it('handles an empty history', () => {
    expect(sortVersionsNewestFirst([])).toEqual([]);
  });
});

describe('isOriginal', () => {
  const history = [version('c', 300), version('b', 200), version('a', 100)];

  it('is the oldest snapshot', () => {
    expect(isOriginal(version('a', 100), history)).toBe(true);
  });

  it('is not any later snapshot', () => {
    expect(isOriginal(version('b', 200), history)).toBe(false);
    expect(isOriginal(version('c', 300), history)).toBe(false);
  });

  it('finds the oldest even when the list arrives unsorted', () => {
    // Sync makes no promise about order, so this must not depend on the input
    // already being newest-first.
    const shuffled = [version('b', 200), version('a', 100), version('c', 300)];
    expect(isOriginal(version('a', 100), shuffled)).toBe(true);
    expect(isOriginal(version('c', 300), shuffled)).toBe(false);
  });

  it('is false against an empty history', () => {
    expect(isOriginal(version('a', 100), [])).toBe(false);
  });
});

describe('describeAge', () => {
  const now = 1_000_000_000_000;
  const ago = (ms: number) => describeAge(now - ms, now);

  it('reads as just now for the last few seconds', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(30_000)).toBe('just now');
  });

  it('counts minutes, then hours, then days', () => {
    expect(ago(5 * 60_000)).toBe('5 min ago');
    expect(ago(60 * 60_000)).toBe('an hour ago');
    expect(ago(5 * 60 * 60_000)).toBe('5 hours ago');
    expect(ago(26 * 60 * 60_000)).toBe('yesterday');
    expect(ago(4 * 24 * 60 * 60_000)).toBe('4 days ago');
  });

  it('rolls over to months', () => {
    expect(ago(31 * 24 * 60 * 60_000)).toBe('a month ago');
    expect(ago(90 * 24 * 60 * 60_000)).toBe('3 months ago');
  });
});
