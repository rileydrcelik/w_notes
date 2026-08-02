/**
 * Search matching and ranking.
 *
 * Two bugs live behind this file. The first is that every search ran
 * `body.toLowerCase().includes(q)` over canonical rich-text **HTML**, so a query
 * for `div` matched every formatted note and a phrase broken by an inline tag
 * matched none — the markup cases below are the regression net for that. The
 * second is that matching was a boolean, so relevance was whatever order the
 * store happened to return; the ranking cases pin the order instead.
 *
 * Scores are asserted as *orderings*, never as absolute numbers. The bands are
 * an implementation detail and re-tuning them shouldn't rewrite this file — what
 * must not change is which of two things comes first.
 */
import { describe, expect, it } from 'vitest';

import { matchesQuery, rankMatches, scoreMatch, NO_MATCH } from '@/lib/search';

/** A note body as the rich editor actually stores it. */
const html = (...blocks: string[]) => blocks.join('');

describe('body matching over rich text', () => {
  it('does not match the markup wrapping the text', () => {
    // The bug, stated directly: every formatted note contains these tag names,
    // and none of them is content the user wrote.
    const body = html('<p>Groceries and <strong>milk</strong></p>', '<ul><li>eggs</li></ul>');
    for (const markup of ['div', 'span', 'strong', 'li', 'p>', '<ul']) {
      expect(matchesQuery({ titles: ['Shopping'], body }, markup)).toBe(false);
    }
  });

  it('matches a word an inline tag splits in two', () => {
    // Bolding part of a word puts a tag inside it: the stored body reads
    // `Q<strong>3</strong>`, so a raw-markup search for "q3" finds nothing even
    // though the note plainly says Q3. Single-term on purpose — a multi-word
    // query would pass without flattening, since each term matches the markup
    // separately and never has to cross the tag.
    const body = html('<p>Q<strong>3</strong> revenue</p>');
    expect(matchesQuery({ titles: ['Notes'], body }, 'q3')).toBe(true);
  });

  it('matches terms that tags sit between', () => {
    const body = html('<p>Remember the <strong>tax</strong> deadline on Friday</p>');
    expect(matchesQuery({ titles: ['Notes'], body }, 'tax deadline')).toBe(true);
  });

  it('still matches text that really is about markup', () => {
    // The flattening must not overshoot: a note whose *content* discusses HTML
    // is a legitimate hit, and the escaped form is what the editor stores.
    const body = html('<p>Use &lt;div&gt; sparingly in the export</p>');
    expect(matchesQuery({ titles: ['Style guide'], body }, 'div')).toBe(true);
  });

  it('matches across block boundaries as separate lines, not as one word', () => {
    // Flattening joins blocks with a newline. Two adjacent paragraphs must not
    // silently weld into "endstart" and invent a match that isn't there.
    const body = html('<p>weekend</p>', '<p>starts</p>');
    expect(matchesQuery({ titles: ['x'], body }, 'weekend')).toBe(true);
    expect(matchesQuery({ titles: ['x'], body }, 'endstart')).toBe(false);
  });
});

describe('scoreMatch', () => {
  const note = (title: string, body = '') => ({ titles: [title], body });

  it('ranks a title match above a body match', () => {
    expect(scoreMatch(note('Tax return'), 'tax')).toBeGreaterThan(
      scoreMatch(note('Groceries', '<p>pay the tax bill</p>'), 'tax'),
    );
  });

  it('ranks an exact title above a title that merely starts with the query', () => {
    expect(scoreMatch(note('Tax'), 'tax')).toBeGreaterThan(scoreMatch(note('Tax return'), 'tax'));
  });

  it('ranks a title prefix above a match buried mid-title', () => {
    expect(scoreMatch(note('Tax return'), 'tax')).toBeGreaterThan(
      scoreMatch(note("Last year's tax"), 'tax'),
    );
  });

  it('ranks a word start above a match inside a word', () => {
    expect(scoreMatch(note('Quarterly tax notes'), 'tax')).toBeGreaterThan(
      scoreMatch(note('Syntax highlighting'), 'tax'),
    );
  });

  it('finds a word start that a buried earlier occurrence hides', () => {
    // "Syntax tax" holds the query twice: buried in "syntax", then as its own
    // word. Scoring only the first occurrence rated this identically to plain
    // "Syntax" — the real word later in the title was never looked at.
    expect(scoreMatch(note('Syntax tax'), 'tax')).toBeGreaterThan(
      scoreMatch(note('Syntax'), 'tax'),
    );
  });

  it('ranks a real substring above a fuzzy one', () => {
    expect(scoreMatch(note('Receipts'), 'rec')).toBeGreaterThan(
      scoreMatch(note('Rice cooker'), 'rec'),
    );
  });

  it('ranks a literal body hit above a fuzzy title guess', () => {
    // "Trailing axe" contains t·a·x only by coincidence; a body that says "tax"
    // says it. The fact beats the guess.
    expect(scoreMatch(note('Groceries', '<p>pay the tax bill</p>'), 'tax')).toBeGreaterThan(
      scoreMatch(note('Trailing axe'), 'tax'),
    );
  });

  it('takes an item’s best field, not its first', () => {
    // One item can hold both — a fuzzy title and a literal body hit. It should
    // score as the body hit rather than being capped at the weaker match.
    const both = note('Trailing axe', '<p>pay the tax bill</p>');
    expect(scoreMatch(both, 'tax')).toBe(scoreMatch(note('Groceries', '<p>pay the tax bill</p>'), 'tax'));
  });

  it('scores no match as zero', () => {
    expect(scoreMatch(note('Groceries', '<p>milk</p>'), 'mortgage')).toBe(NO_MATCH);
    expect(scoreMatch(note('Groceries'), '')).toBe(NO_MATCH);
    expect(scoreMatch(note('Groceries'), '   ')).toBe(NO_MATCH);
  });
});

describe('fuzzy matching', () => {
  const note = (title: string) => ({ titles: [title] });

  it('forgives a typo in a title', () => {
    expect(matchesQuery(note('Groceries'), 'grocries')).toBe(true);
    expect(matchesQuery(note('Mortgage'), 'mrtgage')).toBe(true);
  });

  it('does not match letters that merely happen to appear in order', () => {
    // The failure mode fuzzy search is famous for: without a span limit, "abc"
    // matches almost any long title, and every result looks like a hit.
    expect(matchesQuery(note('A big collection of recipes'), 'abc')).toBe(false);
    expect(matchesQuery(note('Travel plans for the summer'), 'tps')).toBe(false);
  });

  it('needs three characters before it will fuzzy-match at all', () => {
    // Below that, "ab" matches any title containing an a before a b, which is
    // most of them — the match stops meaning anything.
    expect(matchesQuery(note('Grocery list'), 'ab')).toBe(false);
    expect(matchesQuery(note('Grocery list'), 'gro')).toBe(true);
  });

  it('never fuzzy-matches a body', () => {
    // A few kilobytes of prose contains nearly every short subsequence, so
    // fuzzy over a body ranks noise alongside real hits.
    const body = html('<p>grocery list for the weekend</p>');
    expect(matchesQuery({ titles: ['Untitled'], body }, 'grocries')).toBe(false);
    expect(matchesQuery({ titles: ['Untitled'], body }, 'grocery')).toBe(true);
  });
});

describe('multi-word queries', () => {
  it('requires every term to match something', () => {
    const fields = { titles: ['Tax return'], body: html('<p>filed in April</p>') };
    expect(matchesQuery(fields, 'tax april')).toBe(true);
    expect(matchesQuery(fields, 'tax october')).toBe(false);
  });

  it('matches terms across different fields and in any order', () => {
    // "tax deadline" should find a note *titled* Deadline whose body mentions
    // tax — the words need not be adjacent, in order, or in the same field.
    const fields = { titles: ['Deadline'], body: html('<p>the tax one is Friday</p>') };
    expect(matchesQuery(fields, 'tax deadline')).toBe(true);
    expect(matchesQuery(fields, 'deadline tax')).toBe(true);
  });

  it('ignores extra whitespace between and around terms', () => {
    expect(matchesQuery({ titles: ['Tax return'] }, '  tax   return  ')).toBe(true);
  });
});

describe('rankMatches', () => {
  type Item = { id: string; title: string; body?: string; favorite?: boolean };
  const fieldsOf = (item: Item) => ({ titles: [item.title], body: item.body });
  const rank = (items: Item[], query: string) =>
    rankMatches(items, query, fieldsOf, (item) => item.favorite).map((item) => item.id);

  it('drops everything that does not match', () => {
    const items: Item[] = [
      { id: 'a', title: 'Tax return' },
      { id: 'b', title: 'Groceries' },
    ];
    expect(rank(items, 'tax')).toEqual(['a']);
  });

  it('orders by how well each item matches', () => {
    const items: Item[] = [
      { id: 'body', title: 'Errands', body: html('<p>the tax bill</p>') },
      { id: 'mid-title', title: "Last year's tax" },
      { id: 'exact', title: 'Tax' },
      { id: 'prefix', title: 'Tax return' },
    ];
    expect(rank(items, 'tax')).toEqual(['exact', 'prefix', 'mid-title', 'body']);
  });

  it('puts a typo-tolerant match last, behind every literal one', () => {
    // A mistyped query still finds the note, but only after everything that
    // matches it for real.
    const items: Item[] = [
      { id: 'fuzzy', title: 'Groceries' },
      { id: 'body', title: 'Errands', body: html('<p>grocries, misspelled</p>') },
      { id: 'exact', title: 'Grocries' },
    ];
    expect(rank(items, 'grocries')).toEqual(['exact', 'body', 'fuzzy']);
  });

  it('lets a star break a tie without jumping the queue', () => {
    // The whole reason results don't go through `pinnedFirst`: a starred note
    // wins among equally good matches, and loses to a better one.
    const items: Item[] = [
      { id: 'plain-exact', title: 'Tax' },
      { id: 'starred-weak', title: 'Tax return', favorite: true },
      { id: 'plain-weak', title: 'Tax return' },
    ];
    expect(rank(items, 'tax')).toEqual(['plain-exact', 'starred-weak', 'plain-weak']);
  });

  it('keeps the incoming order when items tie completely', () => {
    // The store hands these over in recency order; a stable sort preserves it.
    const items: Item[] = [
      { id: 'first', title: 'Tax return' },
      { id: 'second', title: 'Tax return' },
      { id: 'third', title: 'Tax return' },
    ];
    expect(rank(items, 'tax')).toEqual(['first', 'second', 'third']);
  });

  it('returns nothing for an empty query', () => {
    // Callers gate on `searching` before ranking; if one ever forgets, an empty
    // query must not quietly rank the entire library.
    const items: Item[] = [{ id: 'a', title: 'Tax' }];
    expect(rank(items, '')).toEqual([]);
    expect(rank(items, '   ')).toEqual([]);
  });

  it('searches every name field, not just the first', () => {
    // Copa blocks carry both a label and a filename.
    const items = [{ id: 'file', label: 'Untitled', fileName: 'invoice-april.pdf' }];
    const ranked = rankMatches(items, 'invoice', (item) => ({
      titles: [item.label, item.fileName],
    }));
    expect(ranked.map((item) => item.id)).toEqual(['file']);
  });
});
