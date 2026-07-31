/**
 * Finding the sections of a resume, and splicing an entry into one.
 *
 * The resume adder never rewrites a document. Claude returns the new entry and
 * the section it belongs in; this module decides where in the source that entry
 * lands, and does the insertion itself. That split is the whole safety property:
 * whatever comes back from the model, the only edit that can happen to an
 * existing resume is *inserting a run of text at one offset*. Bullets you wrote
 * cannot be reworded, the preamble cannot be "tidied", and a bad suggestion is a
 * bad new entry rather than a mangled document.
 *
 * `replaceResumeEntry` is the one exception, and it is deliberately the narrowest
 * exception that still does the job. Editing an entry cannot be insert-only —
 * something existing has to change — so instead the model has to **quote what it
 * wants replaced**, and this module applies that quote literally: found once, or
 * not at all. It never searches loosely, never normalises whitespace to make a
 * near-match fit, and never falls back to "closest thing". Outside the one span
 * the model reproduced character-for-character, the document still comes back
 * exactly as it went in.
 *
 * Sectioning is matched narrowly, in the spirit of `engine-choice.ts`: the four
 * commands below are what the templates people actually paste in use (`\section`
 * for Overleaf's article-based resumes, RenderCV and Jake's Resume; `\cvsection`
 * for moderncv derivatives). A template that invents its own sectioning macro
 * reads as having no sections at all, which is the safe way to be wrong — the
 * adder then offers "add a new section" and appends, rather than guessing an
 * offset in the middle of a document it didn't understand.
 */

/**
 * The outcome of applying an edit. A failure is a message to put on screen, not
 * an exception — every way this goes wrong is something the person can act on by
 * describing the entry differently.
 */
export type ReplaceResult =
  | { ok: true; source: string }
  | { ok: false; reason: 'not-found' | 'ambiguous' | 'empty' };

/**
 * `source` with the single occurrence of `oldText` replaced by `newText`.
 *
 * The server checks this too, and this checks it again — not from distrust of
 * the server, but because the source here is the one the editor is actually
 * showing. A resume open on two devices, or edited while the request was in the
 * air, can have moved on since the copy that went up; re-verifying against the
 * live text is what stops a stale edit from landing somewhere it no longer fits.
 *
 * `ambiguous` rather than "replace the first one": if the quote matches twice,
 * one of those places is not the one the person meant, and picking silently
 * would edit text nobody looked at.
 */
export function replaceResumeEntry(
  source: string,
  oldText: string,
  newText: string,
): ReplaceResult {
  if (oldText.length === 0) return { ok: false, reason: 'empty' };

  const first = source.indexOf(oldText);
  if (first === -1) return { ok: false, reason: 'not-found' };
  // Advance by one, not by the quote's length: the question is "how many
  // positions does this match at", and overlapping positions count. A quote of
  // "\n\n" against "\n\n\n" matches at two offsets, and replacing at each gives
  // a *different* document — precisely the ambiguity this check exists to
  // refuse. Stepping by the length would call that unique and silently pick one.
  if (source.indexOf(oldText, first + 1) !== -1) {
    return { ok: false, reason: 'ambiguous' };
  }

  return {
    ok: true,
    source: source.slice(0, first) + newText + source.slice(first + oldText.length),
  };
}

/** A `\section{...}` (or equivalent) found in the source. */
export type LatexSection = {
  /** The section's title, as written. */
  name: string;
  /** Offset of the backslash that starts the sectioning command. */
  start: number;
  /**
   * Offset just past this section's content — the start of the next sectioning
   * command, or of `\end{document}`, or the end of the source.
   */
  end: number;
};

/**
 * Sectioning commands we recognise. `\section*` is the unnumbered form, which is
 * what most resume templates use. The trailing `\b`-ish guard (`(?![a-zA-Z])`)
 * stops `\sectionrule` from reading as `\section` — TeX command names are
 * letters only, so any letter following means it's a different command.
 */
const SECTION_COMMAND = /\\(section|subsection|cvsection|resumeSection)\*?(?![a-zA-Z])\s*\{/g;

/** `\end{document}`, which every insertion has to stay in front of. */
const END_DOCUMENT = /\\end\s*\{\s*document\s*\}/;

/** `\begin{document}` — everything before it is preamble, not content. */
const BEGIN_DOCUMENT = /\\begin\s*\{\s*document\s*\}/;

/**
 * A copy of `source` with comment bodies blanked to spaces.
 *
 * Same reasoning as `engine-choice.ts` — a commented-out `\section` is not a
 * section — but here the result is used for *offsets*, so it has to stay
 * character-for-character aligned with the original. Deleting the comments (the
 * obvious implementation) shifts every offset after the first `%` and silently
 * inserts the entry in the wrong place.
 */
function maskComments(source: string): string {
  let out = '';
  let inComment = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\n') {
      inComment = false;
      out += char;
      continue;
    }
    if (inComment) {
      out += ' ';
      continue;
    }
    // A `%` escaped as `\%` is a literal percent sign, not a comment. The
    // backslash itself may be escaped (`\\%` is a line break then a comment), so
    // count the run rather than looking at one character.
    if (char === '%') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && source[j] === '\\'; j--) backslashes++;
      if (backslashes % 2 === 0) {
        inComment = true;
        out += ' ';
        continue;
      }
    }
    out += char;
  }
  return out;
}

/**
 * Read the balanced `{...}` group that starts at `open` (the index of the `{`).
 * Returns the contents and the offset just past the closing brace, or null if
 * the braces never balance — a truncated document, which is not ours to fix.
 */
function readGroup(source: string, open: number): { text: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') {
      i++; // skip the escaped character, so `\{` isn't counted as a brace
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return { text: source.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Where the document body ends: the `\end{document}` offset, or the source end. */
function bodyEnd(masked: string): number {
  const match = END_DOCUMENT.exec(masked);
  return match ? match.index : masked.length;
}

/**
 * Where the document body starts: just past `\begin{document}`, or 0 for a
 * fragment that has no preamble at all.
 *
 * Skipping the preamble is what keeps a template's *definition* of a section
 * from being read as a section. `\titleformat{\section}{...}` and
 * `\renewcommand{\section}[1]{...}` both mention `\section`, and both live above
 * `\begin{document}` in every template that has them.
 */
function bodyStart(masked: string): number {
  const match = BEGIN_DOCUMENT.exec(masked);
  return match ? match.index + match[0].length : 0;
}

/**
 * Every section in the source, in document order.
 *
 * Titles are returned as written, so a `\section{Work Experience}` offers "Work
 * Experience" in the picker rather than a normalised guess. Sections after
 * `\end{document}` are ignored — that's commented-out scratch space in a lot of
 * pasted templates, and nothing there is part of the resume.
 */
export function resumeSections(source: string): LatexSection[] {
  const masked = maskComments(source);
  const start = bodyStart(masked);
  const limit = bodyEnd(masked);
  const found: { name: string; start: number; contentStart: number }[] = [];

  SECTION_COMMAND.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = SECTION_COMMAND.exec(masked)) !== null) {
    const open = match.index + match[0].length - 1;
    if (match.index >= limit) break;
    const group = readGroup(masked, open);
    if (!group) continue;
    // Read the title from the real source, not the masked copy: a `%` inside a
    // title is masked to a space there, and the offsets are identical anyway.
    found.push({
      name: source.slice(open + 1, group.end - 1).trim(),
      start: match.index,
      contentStart: group.end,
    });
  }

  return found.map((section, i) => ({
    name: section.name,
    start: section.start,
    // A section runs until the next one starts, or until the document ends.
    end: i + 1 < found.length ? found[i + 1].start : limit,
  }));
}

/** The section titles, for the adder's category dropdown. */
export function resumeSectionNames(source: string): string[] {
  return resumeSections(source)
    .map((s) => s.name)
    .filter((name) => name.length > 0);
}

/**
 * Find a section by title, case- and whitespace-insensitively.
 *
 * Loose matching because the title travels to Claude and back as text, and
 * "Experience" coming back as "experience" should still land in the section the
 * user picked rather than quietly creating a second one beside it.
 */
export function findSection(source: string, name: string): LatexSection | null {
  const wanted = name.trim().toLowerCase();
  return resumeSections(source).find((s) => s.name.trim().toLowerCase() === wanted) ?? null;
}

/**
 * `source` with `entry` inserted at the end of the section called `section`, or
 * in a new section of that name if the document has no such section.
 *
 * Everything outside the inserted run is byte-identical to the input. The only
 * judgement calls here are about blank lines, because LaTeX cares: a paragraph
 * break is a blank line, so an entry appended without one runs into the previous
 * paragraph, and three blank lines are the same as one but read as sloppy in the
 * source the user is about to look at.
 */
export function insertResumeEntry(source: string, section: string, entry: string): string {
  const body = entry.trim();
  if (body.length === 0) return source;

  const target = findSection(source, section);
  if (target) {
    // Back up over the whitespace between the last content of the section and
    // whatever follows it, so the entry joins the section rather than being
    // separated from it by the blank lines that precede the next heading.
    let at = target.end;
    while (at > target.start && /\s/.test(source[at - 1])) at--;
    return `${source.slice(0, at)}\n\n${body}\n${source.slice(at)}`;
  }

  const masked = maskComments(source);
  const at = bodyEnd(masked);
  const heading = `\\section{${section.trim()}}`;
  if (at >= masked.length) {
    // No `\end{document}` at all — a fragment rather than a document. Append,
    // and leave the fragment a fragment; inventing an `\end{document}` here
    // would be editing the user's document structure, which is not our job.
    return `${source}\n\n${heading}\n\n${body}\n`;
  }

  // Back up over the blank lines that precede `\end{document}` so the new
  // section joins the body rather than being pushed against the end, then
  // insert *at that point* — the skipped whitespace is kept, not swallowed.
  // Cutting at `before` and resuming at `at` would delete it, which is a small
  // thing to lose but breaks the one property this module is built on: outside
  // the inserted run, the document comes back exactly as it went in.
  let before = at;
  while (before > 0 && /\s/.test(source[before - 1])) before--;
  return `${source.slice(0, before)}\n\n${heading}\n\n${body}\n${source.slice(before)}`;
}
