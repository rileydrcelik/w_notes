/**
 * A line diff, for showing what tailoring did to a resume before it is applied.
 *
 * Line-based rather than word-based because LaTeX is line-structured: an entry is
 * a `\resumeSubheading` line and its bullets, and tailoring works by promoting and
 * demoting whole lines — uncommenting a benched role, commenting out one that
 * doesn't fit. A word diff of that would show a forest of `%` characters moving
 * about and bury the thing you want to see.
 *
 * Plain Myers-style longest-common-subsequence. A resume is a few hundred lines,
 * so the O(n·m) table is trivial here and the result is the minimal edit script,
 * which is what makes an unchanged line read as unchanged rather than as a
 * delete-and-re-add pair.
 */

/**
 * `commented` and `uncommented` are the two that matter most here.
 *
 * Taking an entry off the page in this app means putting a `%` in front of every
 * one of its lines, and putting one back means taking the `%` off. A plain line
 * diff renders that as maximum churn — every line appears twice, once removed and
 * once added, differing by a single character — which is exactly the shape of the
 * change the reader most needs to see at a glance and exactly the shape it
 * communicates worst.
 */
export type DiffKind = 'same' | 'added' | 'removed' | 'commented' | 'uncommented';

export type DiffLine = {
  kind: DiffKind;
  text: string;
};

/**
 * Guard on the LCS table. Two documents this long are not a resume, and the table
 * would be tens of millions of cells — a frozen tab rather than a slow one.
 * Beyond it, callers get a whole-document replacement, which is honest: at that
 * size there is nothing useful to read line by line anyway.
 */
const MAX_LINES = 3_000;

/**
 * The edit script taking `before` to `after`, one entry per line.
 *
 * Trailing whitespace is compared as-is: in LaTeX it can be load-bearing, and a
 * diff that hides a change is worse than one that shows a change you don't care
 * about.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'removed', text })),
      ...b.map((text): DiffLine => ({ kind: 'added', text })),
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  // Built backwards so the walk below runs forwards and emits lines in order.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      // Removals before additions at the same position, so a replaced line reads
      // as "this became that" rather than the other way round.
      out.push({ kind: 'removed', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] });
  while (j < b.length) out.push({ kind: 'added', text: b[j++] });

  return out;
}

/** The comment marker this app puts in front of a line to take it off the page. */
const COMMENT = /^(\s*)%\s?(.*)$/;

/** Whether `after` is `before` with a comment marker put in front of it. */
function isCommentOf(before: string, after: string): boolean {
  const match = COMMENT.exec(after);
  if (!match) return false;
  // Compared with whitespace collapsed at the edges: the marker is inserted after
  // the indentation, and re-indentation around it is not a change worth showing.
  return match[2].trim() === before.trim() && before.trim().length > 0;
}

/**
 * Fold each removed/added pair that differs only by a comment marker into one
 * row, so taking an entry off the page reads as one thing happening to it rather
 * than as every line being replaced by a near-copy of itself.
 *
 * Deliberately conservative: a block is folded only when its removals and
 * additions pair up **exactly** — same count, every pair a comment toggle, all
 * in the same direction. Anything else is a real edit that happens to touch
 * commented lines, and is left alone rather than half-collapsed into something
 * that reads as less than it is.
 */
export function foldCommentToggles(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === 'same') {
      out.push(lines[i++]);
      continue;
    }
    // One block of consecutive changes.
    let end = i;
    while (end < lines.length && lines[end].kind !== 'same') end++;
    const block = lines.slice(i, end);
    const removed = block.filter((l) => l.kind === 'removed');
    const added = block.filter((l) => l.kind === 'added');

    const pairs = removed.length > 0 && removed.length === added.length;
    const allCommented =
      pairs && removed.every((r, k) => isCommentOf(r.text, added[k].text));
    const allUncommented =
      pairs && removed.every((r, k) => isCommentOf(added[k].text, r.text));

    if (allCommented) {
      // Show the line as it read on the page, not as the comment it became.
      removed.forEach((r) => out.push({ kind: 'commented', text: r.text }));
    } else if (allUncommented) {
      added.forEach((a) => out.push({ kind: 'uncommented', text: a.text }));
    } else {
      out.push(...block);
    }
    i = end;
  }
  return out;
}

/** How many lines the diff changes, by kind. */
export function diffStat(lines: DiffLine[]): {
  added: number;
  removed: number;
  commented: number;
  uncommented: number;
} {
  const stat = { added: 0, removed: 0, commented: 0, uncommented: 0 };
  for (const line of lines) {
    if (line.kind !== 'same') stat[line.kind]++;
  }
  return stat;
}

/** A one-line account of what changed, in the terms the resume thinks in. */
export function describeDiff(lines: DiffLine[]): string {
  const { added, removed, commented: off, uncommented: on } = diffStat(lines);
  const parts: string[] = [];
  // Ordered by how much they change the page, not alphabetically.
  if (on) parts.push(`${on} put back on the page`);
  if (off) parts.push(`${off} taken off the page`);
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  return parts.length ? parts.join(' · ') : 'No changes';
}


/**
 * Drop long stretches of unchanged lines, keeping `context` either side of each
 * change — the same thing `diff -u` does, and for the same reason: a resume's
 * preamble is thirty identical lines and scrolling past them to find the change
 * is the opposite of reviewing it.
 *
 * Collapsed runs are replaced by a single `gap` entry carrying how many lines it
 * stands for, so the view can say "24 unchanged lines" rather than silently
 * pretending the document is shorter than it is.
 */
export type DiffRow = DiffLine | { kind: 'gap'; count: number };

export function collapseUnchanged(lines: DiffLine[], context = 3): DiffRow[] {
  // Which lines are near enough to a change to be worth showing.
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = index - context; k <= index + context; k++) {
      if (k >= 0 && k < lines.length) keep[k] = true;
    }
  });

  const rows: DiffRow[] = [];
  let run = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (run > 0) {
        rows.push({ kind: 'gap', count: run });
        run = 0;
      }
      rows.push(line);
    } else {
      run++;
    }
  });
  if (run > 0) rows.push({ kind: 'gap', count: run });
  return rows;
}
