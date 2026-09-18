import { describe, expect, it } from 'vitest';

import { countByStatus, groupEntries, parseTracker, setEntryStatus } from '../internship';

const rows = (body: string) => parseTracker(body).map((e) => `${e.status}:${e.text}`);

describe('parseTracker', () => {
  it('reads each list item, with its tag as the status', () => {
    expect(rows('<html><ul><li>[offer] Google</li><li>[oa] Meta</li><li>[proc] Stripe</li></ul></html>')).toEqual([
      'offer:Google',
      'oa:Meta',
      'proc:Stripe',
    ]);
  });

  it('reads an untagged line as applied — a converted list changes nothing', () => {
    const [entry] = parseTracker('<ul><li>Jane Street</li></ul>');
    expect(entry).toMatchObject({ status: 'applied', tagged: false, text: 'Jane Street' });
  });

  it('reads ordered, checkbox and paragraph lists, and plain text', () => {
    expect(rows('<ol><li>A</li></ol>')).toEqual(['applied:A']);
    expect(rows('<ul data-type="checkbox"><li checked>[rejected] B</li></ul>')).toEqual(['rejected:B']);
    expect(rows('<html><p>[offer] C</p><p>D</p></html>')).toEqual(['offer:C', 'applied:D']);
    expect(rows('[oa] E\n\nF')).toEqual(['oa:E', 'applied:F']);
  });

  it('takes the tag case-insensitively, behind formatting and spaces', () => {
    expect(rows('<ul><li><b>[OFFER] Bold</b></li><li>&nbsp;[Rejected]&nbsp;Spaced</li></ul>')).toEqual([
      'offer:Bold',
      'rejected:Spaced',
    ]);
  });

  it('leaves an unknown bracket in the text', () => {
    expect(rows('<ul><li>[waitlist] X</li></ul>')).toEqual(['applied:[waitlist] X']);
  });

  it('decodes entities', () => {
    expect(rows('<ul><li>AT&amp;T &lt;SWE&gt;</li></ul>')).toEqual(['applied:AT&T <SWE>']);
  });

  it('keeps a nested list as the item\'s detail, not as entries', () => {
    const [entry, ...rest] = parseTracker('<ul><li>[oa] Google<ul><li>due friday</li></ul></li></ul>');
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ status: 'oa', text: 'Google', detail: 'due friday' });
  });

  it('reads only top-level lists — a list quoted inside a note is a note', () => {
    expect(rows('<blockquote><ul><li>quoted</li></ul></blockquote><ul><li>Real</li></ul>')).toEqual(['applied:Real']);
  });

  it('skips blank lines, headings and code', () => {
    expect(
      rows('<html><h1>Summer</h1><p></p><br><codeblock><p>x</p></codeblock><ul><li></li><li>Real</li></ul></html>'),
    ).toEqual(['applied:Real']);
  });

  it('survives malformed markup', () => {
    expect(rows('<ul><li>A</ul><li>stray</li></ul>')).toEqual(['applied:A']);
    expect(rows('</li></ul><p>ok</p>')).toEqual(['applied:ok']);
    expect(parseTracker('')).toEqual([]);
    expect(parseTracker(null)).toEqual([]);
  });
});

describe('groupEntries', () => {
  it('orders statuses furthest-along first, alphabetical inside, empties dropped', () => {
    const body = '<ul><li>[rejected] Zed</li><li>beta</li><li>[offer] Omega</li><li>Alpha</li><li>[offer] item 10</li><li>[offer] item 9</li></ul>';
    expect(groupEntries(parseTracker(body)).map((g) => [g.status, g.entries.map((e) => e.text)])).toEqual([
      ['offer', ['item 9', 'item 10', 'Omega']],
      ['applied', ['Alpha', 'beta']],
      ['rejected', ['Zed']],
    ]);
  });
});

describe('countByStatus', () => {
  it('counts each status and the total', () => {
    const counts = countByStatus(parseTracker('<ul><li>[offer] A</li><li>B</li><li>C</li><li>[oa] D</li></ul>'));
    expect(counts).toEqual({ offer: 1, proc: 0, oa: 1, applied: 2, rejected: 0, total: 4 });
  });
});

describe('setEntryStatus', () => {
  const body = '<html><ul><li><b>Google</b></li><li>[oa] Meta<ul><li>note</li></ul></li><li>Stripe</li></ul></html>';

  it('tags an untagged line, changing nothing outside it', () => {
    const out = setEntryStatus(body, { index: 2, text: 'Stripe' }, 'offer')!;
    expect(out).toBe(body.replace('<li>Stripe</li>', '<li>[offer] Stripe</li>'));
  });

  it('puts the tag inside the line\'s formatting', () => {
    const out = setEntryStatus(body, { index: 0, text: 'Google' }, 'rejected')!;
    expect(out).toBe(body.replace('<b>Google</b>', '<b>[rejected] Google</b>'));
  });

  it('replaces an existing tag and keeps the nested detail', () => {
    const out = setEntryStatus(body, { index: 1, text: 'Meta' }, 'proc')!;
    expect(out).toBe(body.replace('[oa] Meta', '[proc] Meta'));
    expect(parseTracker(out)[1]).toMatchObject({ status: 'proc', detail: 'note' });
  });

  it('finds the line by text when the list moved underneath', () => {
    const moved = '<ul><li>New</li><li>Stripe</li></ul>';
    expect(setEntryStatus(moved, { index: 0, text: 'Stripe' }, 'oa')).toBe('<ul><li>New</li><li>[oa] Stripe</li></ul>');
  });

  it('does nothing when the line is gone', () => {
    expect(setEntryStatus(body, { index: 5, text: 'Nope' }, 'oa')).toBeNull();
  });

  it('edits a plain-text line in place', () => {
    expect(setEntryStatus('A\n[oa] B', { index: 1, text: 'B' }, 'offer')).toBe('A\n[offer] B');
  });
});
