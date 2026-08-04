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

import {
  matchSnippet,
  matchesQuery,
  rankMatches,
  scoreMatch,
  NO_MATCH,
  type SnippetPart,
} from '@/lib/search';

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

describe('match snippet', () => {
  /** The text a snippet shows, as a reader would see it. */
  const shown = (parts: SnippetPart[] | null) => (parts ?? []).map((part) => part.text).join('');
  /** Just the runs the snippet marks as matched. */
  const marked = (parts: SnippetPart[] | null) =>
    (parts ?? []).filter((part) => part.match).map((part) => part.text);

  it('shows the words around a hit buried in the body', () => {
    // The whole point: this note is in the results because of a sentence far
    // below the fold, and its ordinary preview would show none of it.
    const body = html(
      '<p>Opening paragraph about nothing in particular at all.</p>',
      '<p>Then, much later, the quarterly tax deadline is the 15th.</p>',
    );
    const snippet = matchSnippet(body, 'deadline');
    expect(marked(snippet)).toEqual(['deadline']);
    expect(shown(snippet)).toContain('quarterly tax deadline is the 15th');
  });

  it('says nothing when the body does not contain the query', () => {
    // A title hit already shows the reader why the card is there, and a fuzzy
    // one has no literal text to point at. Inventing an excerpt for either
    // would put words in the note's mouth, so both fall back to the preview.
    const body = html('<p>Milk, eggs, bread.</p>');
    expect(matchSnippet(body, 'groceries')).toBeNull();
    expect(matchSnippet(body, 'grocries')).toBeNull();
    expect(matchSnippet('', 'milk')).toBeNull();
    expect(matchSnippet(body, '   ')).toBeNull();
  });

  it('quotes the note in its own case', () => {
    // Matching is case-insensitive; the excerpt is a quotation, and a
    // lower-cased one would misreport what the note says.
    const snippet = matchSnippet(html('<p>The Tax Deadline moved.</p>'), 'tax deadline');
    expect(shown(snippet)).toContain('Tax Deadline');
    // Two runs, not one: terms are matched independently and need not be
    // adjacent, so the space between them is ordinary text that happens to sit
    // between two hits.
    expect(marked(snippet)).toEqual(['Tax', 'Deadline']);
  });

  it('reads through the markup, like the matching does', () => {
    // Same bug as the rest of this file: the stored body is `Q<strong>3</strong>`,
    // so a snippet taken from the raw HTML would neither find the match nor be
    // readable if it did.
    const snippet = matchSnippet(html('<p>Q<strong>3</strong> revenue is up</p>'), 'q3');
    expect(shown(snippet)).toBe('Q3 revenue is up');
    expect(marked(snippet)).toEqual(['Q3']);
  });

  it('marks every occurrence it shows, and every term of the query', () => {
    // A reader scanning the excerpt shouldn't have to wonder why one instance
    // of the word is lit and the next one isn't.
    const body = html('<p>tax season means tax forms and a tax bill</p>');
    expect(marked(matchSnippet(body, 'tax'))).toEqual(['tax', 'tax', 'tax']);
    expect(marked(matchSnippet(body, 'tax bill'))).toEqual(['tax', 'tax', 'tax', 'bill']);
  });

  it('marks overlapping terms once rather than twice', () => {
    // "tax" and "ax" both hit the same letters; two ranges over one word would
    // slice it into fragments and render it as three separate runs.
    const snippet = matchSnippet(html('<p>the tax form</p>'), 'tax ax');
    expect(marked(snippet)).toEqual(['tax']);
    expect(shown(snippet)).toBe('the tax form');
  });

  it('ellipsizes what it cut, and cuts on word boundaries', () => {
    const body = html(
      `<p>${'padding word '.repeat(12)}the quarterly deadline arrives ${'trailing word '.repeat(12)}</p>`,
    );
    const snippet = matchSnippet(body, 'deadline');
    const text = shown(snippet);
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    // No half-words at either edge: every word between the ellipses is whole.
    expect(text.replace(/^…|…$/g, '').split(' ')).not.toContain('');
    for (const word of text.replace(/^…|…$/g, '').trim().split(' ')) {
      expect(['padding', 'word', 'the', 'quarterly', 'deadline', 'arrives', 'trailing']).toContain(word);
    }
  });

  it('does not ellipsize a body that fits whole', () => {
    // The ellipsis means "there is more here"; on a short note there isn't, and
    // a decorative one would be a lie about the note's length.
    expect(shown(matchSnippet(html('<p>a short tax note</p>'), 'tax'))).toBe('a short tax note');
  });

  it('reads a multi-block body as one run of prose', () => {
    // Blocks are lines in the flattened body; a card shows a single excerpt, so
    // they have to arrive as spaces — and one-for-one, or every offset after
    // the first line would point at the wrong character.
    const snippet = matchSnippet(html('<p>First line</p>', '<p>tax second line</p>'), 'tax');
    expect(shown(snippet)).toBe('First line tax second line');
    expect(marked(snippet)).toEqual(['tax']);
  });

  it('shows nothing rather than an excerpt that highlights nothing', () => {
    // Two ways the window can close before it reaches the match: a term longer
    // than the window, and a caller asking for a length that can't hold one.
    // Both used to return a "snippet" with no marked run — an excerpt claiming
    // to say why the card matched while pointing at nothing — and the second
    // built that from an empty list of parts and threw.
    const long = 'z'.repeat(200);
    expect(matchSnippet(html(`<p>a note containing ${long} in it</p>`), long)).toBeNull();
    expect(matchSnippet(html('<p>the tax form</p>'), 'tax', 0)).toBeNull();
    expect(matchSnippet(html('<p>the tax form</p>'), 'tax', -5)).toBeNull();
  });

  it('keeps the match inside the window however narrow it is', () => {
    // The window is measured from a point *before* the match, and its far edge
    // is then pulled back to a word boundary — so a narrow one can land inside
    // the match and trim away the very words it exists to show. A range of
    // widths, because the failure only appears at those that put the last
    // boundary short of the match's end.
    const body = html(`<p>${'padding word '.repeat(12)}deadline${' trailing word'.repeat(12)}</p>`);
    for (const width of [26, 30, 34, 40, 60, 90]) {
      expect(marked(matchSnippet(body, 'deadline', width))).toEqual(['deadline']);
    }
  });
});
