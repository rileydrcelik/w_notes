import { htmlToPlainText } from '@/lib/html-text';

/**
 * Matching and ranking for every search field in the app — the home grid, the
 * sidebar tree, and the copa feed all score through here.
 *
 * Two things were wrong with the per-screen `includes()` calls this replaces.
 *
 * The first was a correctness bug with a visible symptom: bodies are canonical
 * rich-text HTML, and the searches ran over the raw markup. Searching `div` or
 * `span` matched every formatted note, and a phrase interrupted by any inline
 * tag — `the <strong>tax</strong> deadline` — matched nothing at all. Bodies are
 * flattened here before anything looks at them.
 *
 * The second was that a match was a boolean, so a note whose title *is* the
 * query sorted no higher than one that mentions it once in paragraph nine.
 * Scores put those in order.
 */

/**
 * Score bands, widely spaced so a better *kind* of match always outranks a
 * worse one and the within-band tiebreak can never cross a boundary.
 */
const TITLE_EXACT = 1000;
const TITLE_PREFIX = 800;
const TITLE_WORD_PREFIX = 700;
const TITLE_SUBSTRING = 600;
/**
 * A literal hit anywhere beats a fuzzy one: a body that contains the word is a
 * fact, a fuzzily-matched title is a guess. Ordering these the other way put
 * "Trailing axe" — t·a·x, a coincidence — above a note whose text says "tax".
 */
const BODY_SUBSTRING = 400;
const TITLE_FUZZY = 200;

/** No match. Exported so callers can read `score > NO_MATCH` as "it matched". */
export const NO_MATCH = 0;

/**
 * Ceiling on the position tiebreak. Strictly below the 100-point gap between
 * the closest two bands, so an earlier match inside a weaker band can never
 * outrank a stronger one.
 */
const POSITION_BONUS = 99;

/**
 * Shortest query that may fuzzy-match. Below this nearly every title contains
 * the letters in order somewhere and fuzzy stops carrying information — "ab"
 * would match "Grocery list" ⟨**a**pple, **b**read⟩ as readily as "Abstract".
 */
const MIN_FUZZY_LENGTH = 3;

/**
 * How far apart a fuzzy match's first and last character may sit, as a multiple
 * of the query length. Without a bound, subsequence matching finds "abc" in any
 * long title that happens to contain those letters in order — which is most of
 * them. Keeping the window tight is what separates a typo from a coincidence.
 *
 * Doubled, not wider: a typo is a *dense* match (dropping or transposing a
 * letter or two leaves the span near the query's own length), so 2× covers
 * "grocries" → "groceries" while excluding "abc" → "**A** **b**ig
 * **c**ollection". Matching word initials that way is acronym search — a
 * genuinely useful but different feature, and one worth building deliberately
 * rather than inheriting as a side effect of a loose bound.
 */
const MAX_FUZZY_SPAN = 2;

/**
 * The fields of one searchable thing.
 *
 * `titles` are short name-like fields — a note title, a folder name, a copa
 * label or filename. They are fuzzy-matched, because a name is what someone
 * half-remembers and mistypes. `body` is long-form content, matched by
 * substring only: fuzzy over several kilobytes of prose finds a subsequence in
 * everything and ranks noise alongside real hits.
 */
export type SearchFields = {
  titles: string[];
  /** Rich-text HTML or plain text — flattened here either way. */
  body?: string;
};

/**
 * A flattened body, in the two forms this module needs it: `lower` to match
 * against, `text` to show. Both are kept because a snippet quotes the note back
 * to the reader, and lower-casing what it quotes would be a visible lie about
 * what the note says.
 */
type FlatBody = { text: string; lower: string };

/**
 * Flattened bodies, keyed by the HTML they came from.
 *
 * The sidebar re-tests the same note once per ancestor folder as it prunes the
 * tree, so a single keystroke can ask for the same body a dozen times; without
 * this, each one re-runs the whole regex chain in `htmlToPlainText`.
 *
 * Cleared wholesale at the cap rather than evicted one entry at a time. Editing
 * a note produces a new body string per keystroke, so entries are naturally
 * short-lived and an LRU's bookkeeping would cost more than the occasional
 * re-flatten it saves.
 */
const bodyCache = new Map<string, FlatBody>();
const BODY_CACHE_LIMIT = 200;

function flatBody(html: string): FlatBody {
  const hit = bodyCache.get(html);
  if (hit !== undefined) return hit;
  const text = htmlToPlainText(html);
  const flat = { text, lower: text.toLowerCase() };
  if (bodyCache.size >= BODY_CACHE_LIMIT) bodyCache.clear();
  bodyCache.set(html, flat);
  return flat;
}

function bodyText(html: string): string {
  return flatBody(html).lower;
}

/**
 * Whether `term`'s characters all appear in `text` in order and close enough
 * together to be a plausible typo rather than a coincidence — and if so, where
 * the match starts.
 *
 * Found in two passes. The first sweeps forward for the earliest position that
 * completes the term, which fixes the window's end; the second walks back from
 * there to the latest start that still spans every character. Greedy matching
 * alone reports the first character it sees, so "abc" against "a … 40 chars …
 * bc" would claim a 43-character span and be rejected even though a tight match
 * sits at the end.
 */
function fuzzyIndex(text: string, term: string): number {
  if (term.length < MIN_FUZZY_LENGTH) return -1;

  let ti = 0;
  let end = -1;
  for (let i = 0; i < text.length && ti < term.length; i++) {
    if (text[i] === term[ti]) {
      ti++;
      end = i;
    }
  }
  if (ti < term.length) return -1;

  let back = term.length - 1;
  let start = end;
  for (let i = end; i >= 0 && back >= 0; i--) {
    if (text[i] === term[back]) {
      start = i;
      back--;
    }
  }

  return end - start + 1 <= term.length * MAX_FUZZY_SPAN ? start : -1;
}

/** Bonus for matching early, so "tax" ranks "Tax return" above "Last year's tax". */
function positionBonus(index: number): number {
  return Math.max(0, POSITION_BONUS - index);
}

/** True when `index` begins a word — the start of the text or just after a separator. */
function atWordStart(text: string, index: number): boolean {
  return index === 0 || /[\s\-_/.,:;([{]/.test(text[index - 1]);
}

/** Best score any one title field earns for one term. */
function scoreTitle(title: string, term: string): number {
  const text = title.toLowerCase();
  if (!text) return NO_MATCH;
  if (text === term) return TITLE_EXACT;

  const first = text.indexOf(term);
  if (first === 0) return TITLE_PREFIX + positionBonus(0);

  if (first > 0) {
    // Keep looking past the first hit for one that starts a word. "Syntax tax"
    // contains the query twice — buried at 3, then as its own word at 7 — and
    // scoring only the first occurrence rated that title no better than plain
    // "Syntax", which is the ranking this module exists to get right.
    //
    // The *first* word start is the best of them, so the scan can stop there:
    // every later occurrence sits in the same band or lower and earns a smaller
    // position bonus. If none starts a word, the first occurrence wins for the
    // same reason.
    let at = first;
    while (at > 0 && !atWordStart(text, at)) at = text.indexOf(term, at + 1);
    return at > 0
      ? TITLE_WORD_PREFIX + positionBonus(at)
      : TITLE_SUBSTRING + positionBonus(first);
  }

  const fuzzy = fuzzyIndex(text, term);
  return fuzzy >= 0 ? TITLE_FUZZY + positionBonus(fuzzy) : NO_MATCH;
}

/** Score for one term against one thing's fields. Zero means it didn't match. */
function scoreTerm(fields: SearchFields, term: string): number {
  let best = NO_MATCH;
  for (const title of fields.titles) {
    const score = scoreTitle(title, term);
    if (score > best) best = score;
  }

  // A literal title hit can't be beaten by anything in the body, so skip the
  // flattening entirely — the common case, and the one where it costs most.
  // Safe by construction: the position bonus is capped below the gap between
  // the two bands, so `BODY_SUBSTRING + bonus` can never reach TITLE_SUBSTRING.
  if (best >= TITLE_SUBSTRING) return best;

  if (!fields.body) return best;
  const at = bodyText(fields.body).indexOf(term);
  // Max, not short-circuit: a body that literally contains the term outranks a
  // title that only fuzzily does, and the same item can hold both.
  return at >= 0 ? Math.max(best, BODY_SUBSTRING + positionBonus(at)) : best;
}

/** The words a query is made of, lower-cased. Empty for a blank query. */
function queryTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * How well one thing matches a query. Zero means it doesn't; higher is better.
 * Only the ordering of scores is meaningful — never the absolute number.
 *
 * A multi-word query is split on whitespace and **every** term must match
 * something, though not the same field and not in the query's order: "tax
 * deadline" finds a note titled "Deadline" whose body mentions tax. The score
 * is the mean of the per-term scores, which keeps it inside the same bands as a
 * single-term query so the two rank consistently against each other.
 */
export function scoreMatch(fields: SearchFields, query: string): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return NO_MATCH;

  let total = 0;
  for (const term of terms) {
    const score = scoreTerm(fields, term);
    if (score === NO_MATCH) return NO_MATCH;
    total += score;
  }
  return total / terms.length;
}

/** Whether a thing matches at all — the boolean the tree views need. */
export function matchesQuery(fields: SearchFields, query: string): boolean {
  return scoreMatch(fields, query) > NO_MATCH;
}

/**
 * Rank matching items best-first, dropping the rest.
 *
 * Favorites break ties rather than jumping the queue: a starred note is worth
 * surfacing among equally good matches, but a star doesn't make it a better
 * answer than the note the query actually names. That's why a search result
 * list is sorted through here instead of through `pinnedFirst`.
 *
 * The sort is stable, so items that tie on both score and star keep whatever
 * order they arrived in — the feed's recency ordering.
 */
export function rankMatches<T>(
  items: T[],
  query: string,
  fieldsOf: (item: T) => SearchFields,
  // Optional-returning, because `favorite` is an optional flag on both notes and
  // folders and an absent one simply means "not starred" — pushing that coercion
  // onto every caller would be noise.
  favoriteOf?: (item: T) => boolean | undefined,
): T[] {
  const scored = items
    .map((item) => ({ item, score: scoreMatch(fieldsOf(item), query) }))
    .filter((entry) => entry.score > NO_MATCH);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (!favoriteOf) return 0;
    return Number(favoriteOf(b.item)) - Number(favoriteOf(a.item));
  });

  return scored.map((entry) => entry.item);
}

/**
 * One run of snippet text, flagged when it is part of what the query matched.
 * A snippet is a list of these so a card can emphasise the matched words in
 * place rather than showing the reader a paragraph and leaving them to find it.
 */
export type SnippetPart = { text: string; match: boolean };

/**
 * Characters of the note kept ahead of the match. Enough for the phrase to have
 * a run-up — a match flush against the left edge reads as the start of the note,
 * which it usually isn't.
 */
const SNIPPET_LEAD = 24;

/** Characters a snippet may show, before its ellipses. About four narrow lines. */
const SNIPPET_LENGTH = 140;

/** Merge overlapping/touching ranges, which two terms sharing letters produce. */
function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * A window of a note's body around what the query matched, with the matched
 * words marked.
 *
 * Ranking put the note in the list; this says *why* it's there. A body-only hit
 * — the query appears in paragraph nine and nowhere in the title — otherwise
 * renders an ordinary card showing an opening paragraph with no trace of what
 * was searched for, and the reader has to open every result to find out which
 * one they meant.
 *
 * Returns `null` when no term is literally in the body, which is the case for a
 * title match and for a fuzzy one. That's deliberate: the caller falls back to
 * the note's normal preview, so a card never invents a reason it can't point at.
 * It means the snippet is only ever shown when it is true.
 *
 * Only the *first* match sets the window, and every occurrence inside that
 * window is marked. Chasing the best occurrence would need a second scoring
 * pass, and for a card-sized excerpt the earliest hit is as good an answer as
 * any — it is the one a reader scanning from the top would find first.
 */
export function matchSnippet(
  body: string,
  query: string,
  length: number = SNIPPET_LENGTH,
): SnippetPart[] | null {
  const terms = queryTerms(query);
  if (terms.length === 0 || !body) return null;

  const { text, lower } = flatBody(body);
  if (!text) return null;

  // Earliest literal hit of any term; its own end matters too, so the window
  // can never be trimmed back through the very match it exists to show.
  let first = -1;
  let firstEnd = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (first < 0 || at < first)) {
      first = at;
      firstEnd = at + term.length;
    }
  }
  if (first < 0) return null;

  // Snap the window's edges to word boundaries: half a word at either end reads
  // as a typo rather than as an excerpt.
  let from = Math.max(0, first - SNIPPET_LEAD);
  if (from > 0) {
    const gap = text.slice(from, first).search(/\s/);
    if (gap >= 0) from += gap + 1;
  }

  let to = Math.min(text.length, from + length);
  if (to < text.length) {
    const cut = text.slice(0, to).search(/\s\S*$/);
    // Only back up to a boundary that still leaves the match whole. A narrow
    // window can land mid-match, and trimming to the last space would then cut
    // away the very words the snippet exists to show — a trailing part-word is
    // the lesser evil. `>=` so a boundary sitting exactly at the end of the
    // match counts as leaving it whole.
    if (cut >= firstEnd) to = cut;
  }

  const ranges: [number, number][] = [];
  for (const term of terms) {
    let at = lower.indexOf(term, from);
    while (at >= 0 && at + term.length <= to) {
      ranges.push([at - from, at - from + term.length]);
      at = lower.indexOf(term, at + term.length);
    }
  }

  // Blocks became newlines when the body was flattened; a snippet is one run of
  // prose, so they read as spaces here. Substituted one-for-one, which is what
  // keeps the offsets above pointing at the same characters.
  const window = text.slice(from, to).replace(/\n/g, ' ');
  const head = from > 0 ? '…' : '';
  const tail = to < text.length ? '…' : '';

  const parts: SnippetPart[] = [];
  let at = 0;
  for (const [start, end] of mergeRanges(ranges)) {
    if (start > at) parts.push({ text: window.slice(at, start), match: false });
    parts.push({ text: window.slice(start, end), match: true });
    at = end;
  }
  if (at < window.length) parts.push({ text: window.slice(at), match: false });

  if (head) {
    if (parts[0].match) parts.unshift({ text: head, match: false });
    else parts[0] = { text: head + parts[0].text, match: false };
  }
  if (tail) {
    const last = parts[parts.length - 1];
    if (last.match) parts.push({ text: tail, match: false });
    else parts[parts.length - 1] = { text: last.text + tail, match: false };
  }

  return parts;
}
