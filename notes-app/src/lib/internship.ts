/**
 * The internship tracker: a note whose body is an ordinary list, one internship
 * per line, read as a tracker.
 *
 * The list *is* the storage. A line's status is a leading tag in its own text —
 * `[offer] Google` — so the body stays the canonical rich-text HTML every other
 * note uses: it syncs with nothing new, a client that has never heard of a
 * tracker opens it in the plain editor as readable text, and search, trash and
 * export read it as-is. A line with no tag is `applied`, which is what makes
 * converting an existing list a change of type and nothing else.
 *
 * Two rules keep a tracker from losing anything:
 *
 * - **A status change is a splice.** It rewrites the tag inside that one entry
 *   and leaves every other byte of the body alone. The body is never rebuilt
 *   from parsed entries, so formatting, nested notes, images and anything this
 *   parser doesn't understand come through untouched.
 * - **Parsing never throws and never pairs tags by regex.** It walks the block
 *   tags with a stack; a malformed body yields fewer entries, not a broken one.
 *
 * Pure string work — no DOM, no React Native — so it runs under vitest.
 */

/** Display order, furthest along first. */
export const INTERNSHIP_STATUSES = ['offer', 'proc', 'oa', 'applied', 'rejected'] as const;
export type InternshipStatus = (typeof INTERNSHIP_STATUSES)[number];
export const DEFAULT_STATUS: InternshipStatus = 'applied';

export const STATUS_LABEL: Record<InternshipStatus, string> = {
  offer: 'Offer',
  proc: 'In process',
  oa: 'OA',
  applied: 'Applied',
  rejected: 'Rejected',
};

export type TrackerEntry = {
  /** Ordinal among entries, in document order. */
  index: number;
  status: InternshipStatus;
  /** Whether the line carried a recognised tag (untagged reads as applied). */
  tagged: boolean;
  /** What the row shows: plain text, tag stripped, entities decoded. */
  text: string;
  /** Plain text of a list nested under this item, '' if none. */
  detail: string;
  /** Source offsets of the entry's own inline content — the splice window. */
  contentStart: number;
  contentEnd: number;
};

const BLOCK_TAG =
  /<(\/?)(ul|ol|li|p|h[1-6]|blockquote|codeblock|pre)\b((?:"[^"]*"|'[^']*'|[^>])*)>/gi;

// Leading run a tag may sit behind: whitespace, and the opening tags of inline
// formatting (so a line bolded as a whole still has its tag found).
const LEAD = String.raw`(?:\s|&nbsp;| |<(?:b|strong|i|em|u|s|span|a|p)\b(?:"[^"]*"|'[^']*'|[^>])*>)*`;
const TAG_AT_START = new RegExp(
  `^(${LEAD})\\[(${INTERNSHIP_STATUSES.join('|')})\\](?:\\s|&nbsp;|\\u00a0)*`,
  'i',
);
const LEAD_ONLY = new RegExp(`^${LEAD}`, 'i');

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Raw = { contentStart: number; contentEnd: number; detail: string };

/** Entry windows in an HTML body, in document order. */
function htmlEntries(body: string): Raw[] {
  const out: Raw[] = [];
  const stack: string[] = [];
  // The item or paragraph currently being read, if it's one that counts.
  let open: { tag: 'li' | 'p'; depth: number; contentStart: number; contentEnd: number | null; nestedFrom: number | null } | null = null;

  BLOCK_TAG.lastIndex = 0;
  for (let m = BLOCK_TAG.exec(body); m; m = BLOCK_TAG.exec(body)) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const end = m.index + m[0].length;

    if (!closing) {
      if (open && open.contentEnd === null && (tag === 'ul' || tag === 'ol') && stack.length > open.depth) {
        // A list nested inside the item: its own text ends here, the rest is detail.
        open.contentEnd = m.index;
        open.nestedFrom = m.index;
      }
      const topLevelItem = tag === 'li' && stack.length === 1 && (stack[0] === 'ul' || stack[0] === 'ol');
      const topLevelLine = tag === 'p' && stack.length === 0;
      if (!open && (topLevelItem || topLevelLine)) {
        open = { tag, depth: stack.length, contentStart: end, contentEnd: null, nestedFrom: null };
      }
      stack.push(tag);
      continue;
    }

    // Closing: pop back to the matching open tag. One that was never opened is
    // ignored rather than allowed to unwind the whole stack.
    const at = stack.lastIndexOf(tag);
    if (at === -1) continue;
    stack.length = at;
    // Its own close, or an ancestor closing over an item left unclosed.
    if (open && stack.length <= open.depth) {
      const contentEnd = open.contentEnd ?? m.index;
      const detail = open.nestedFrom !== null ? plainText(body.slice(open.nestedFrom, m.index)) : '';
      out.push({ contentStart: open.contentStart, contentEnd, detail });
      open = null;
    }
  }
  return out;
}

/** Entry windows in a body with no markup at all: one per non-blank line. */
function textEntries(body: string): Raw[] {
  const out: Raw[] = [];
  let start = 0;
  for (const line of body.split('\n')) {
    out.push({ contentStart: start, contentEnd: start + line.length, detail: '' });
    start += line.length + 1;
  }
  return out;
}

export function parseTracker(body: string | null | undefined): TrackerEntry[] {
  if (!body) return [];
  const raws = /<[a-z!/]/i.test(body) ? htmlEntries(body) : textEntries(body);
  const entries: TrackerEntry[] = [];
  for (const raw of raws) {
    const content = body.slice(raw.contentStart, raw.contentEnd);
    const tag = TAG_AT_START.exec(content);
    const rest = tag ? tag[1] + content.slice(tag[0].length) : content;
    const text = plainText(rest);
    // A line with nothing to read — blank, or only a picture — isn't an
    // internship. It stays in the body; it just isn't a row.
    if (!text) continue;
    entries.push({
      index: entries.length,
      status: tag ? (tag[2].toLowerCase() as InternshipStatus) : DEFAULT_STATUS,
      tagged: !!tag,
      text,
      detail: raw.detail,
      contentStart: raw.contentStart,
      contentEnd: raw.contentEnd,
    });
  }
  return entries;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Entries by status in display order, alphabetical within each. Empty
 *  statuses are left out. */
export function groupEntries(entries: TrackerEntry[]): { status: InternshipStatus; entries: TrackerEntry[] }[] {
  return INTERNSHIP_STATUSES.map((status) => ({
    status,
    entries: entries
      .filter((e) => e.status === status)
      .sort((a, b) => collator.compare(a.text, b.text) || a.index - b.index),
  })).filter((group) => group.entries.length > 0);
}

export function countByStatus(entries: TrackerEntry[]): Record<InternshipStatus, number> & { total: number } {
  const counts = { offer: 0, proc: 0, oa: 0, applied: 0, rejected: 0, total: entries.length };
  for (const e of entries) counts[e.status]++;
  return counts;
}

/**
 * The body with one entry's status changed, or null if that entry can no
 * longer be found (the body moved underneath — the caller should do nothing).
 *
 * The entry is found in the *current* body by its index, confirmed by its text,
 * falling back to the first entry with the same text — so a status tapped a
 * moment after another device reordered the list still lands on the right line
 * or on none, never on a neighbour.
 */
export function setEntryStatus(
  body: string,
  target: { index: number; text: string },
  status: InternshipStatus,
): string | null {
  const entries = parseTracker(body);
  const entry =
    (entries[target.index]?.text === target.text ? entries[target.index] : undefined) ??
    entries.find((e) => e.text === target.text);
  if (!entry) return null;

  const content = body.slice(entry.contentStart, entry.contentEnd);
  const tag = TAG_AT_START.exec(content);
  const lead = tag ? tag[1] : (LEAD_ONLY.exec(content)?.[0] ?? '');
  const replaced = tag ? tag[0].length : lead.length;
  const next = lead + `[${status}] ` + content.slice(replaced);
  return body.slice(0, entry.contentStart) + next + body.slice(entry.contentEnd);
}
