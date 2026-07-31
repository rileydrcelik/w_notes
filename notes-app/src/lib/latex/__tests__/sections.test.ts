/**
 * `sections.ts` finds `\section{...}` (and its siblings) in an arbitrary pasted
 * LaTeX resume and splices a new entry into the source at a computed byte
 * offset. It is the highest-risk file in the resume adder: unlike the model
 * call, this code runs on every document unconditionally, and a bug here reads
 * as data loss — a bullet, a whole section, or the preamble quietly rewritten
 * or dropped.
 *
 * The one property everything else rests on is that `insertResumeEntry` only
 * ever *inserts*. It never deletes and never rewrites a character outside the
 * run it adds. Several tests below check that directly, by reconstructing the
 * original source from the result and the exact text that was spliced in.
 */
import { describe, expect, it } from 'vitest';

import {
  findSection,
  insertResumeEntry,
  resumeSectionNames,
  resumeSections,
} from '@/lib/latex/sections';

/**
 * A realistic Jake's-Resume-style document: a preamble that itself mentions
 * `\section` while *redefining* it (a real pattern — `article.cls` and
 * `titlesec`-based templates both do this), two real sections in the body, and
 * a commented-out section past `\end{document}` — the "scratch space" a lot of
 * pasted templates carry around.
 */
const RESUME = `\\documentclass[letterpaper,11pt]{article}
\\usepackage{titlesec}
% Redefines \\section itself, which is exactly the kind of preamble mention
% that must not be read as a section of the document.
\\renewcommand\\section{\\@startsection{section}{1}{0pt}{-8pt}{4pt}{\\bfseries}}
\\titleformat{\\section}{\\scshape\\raggedright\\large}{}{0em}{}

\\begin{document}

\\section{Education}
University of Example, B.S. Computer Science, 2020 -- 2024

\\section{Experience}
\\textbf{Acme Corp} \\hfill Summer 2023 \\\\
Built the thing.
\\end{document}

% \\section{Scratch}
% old stuff nobody uses
`;

describe('resumeSections', () => {
  it('lists sections in document order, ignoring the preamble redefinition', () => {
    const names = resumeSections(RESUME).map((s) => s.name);
    expect(names).toEqual(['Education', 'Experience']);
  });

  it('recognises the unnumbered \\section* form', () => {
    const source = '\\begin{document}\\section*{Skills}content\\end{document}';
    expect(resumeSectionNames(source)).toEqual(['Skills']);
  });

  it('captures a title with nested braces whole, not truncated at the first }', () => {
    const source =
      '\\begin{document}\\section{A \\textbf{Bold} Title}body\\end{document}';
    expect(resumeSectionNames(source)).toEqual(['A \\textbf{Bold} Title']);
  });

  it('does not let a literal escaped closing brace end the title group early', () => {
    // `\}` is a literal closing-brace character, not a group delimiter. This
    // fixture is deliberately asymmetric — one escaped `}` with no escaped `{`
    // to balance it — so that a reader which fails to skip the escaped
    // character (rather than one that merely mis-balances by an equal amount
    // on both sides) closes the group one character early and is caught.
    const source =
      '\\begin{document}\\section{Explains the closing brace \\}}body\\end{document}';
    expect(resumeSectionNames(source)).toEqual(['Explains the closing brace \\}']);
  });

  it('captures a title with an escaped ampersand whole', () => {
    const source =
      '\\begin{document}\\section{Research \\& Development}body\\end{document}';
    expect(resumeSectionNames(source)).toEqual(['Research \\& Development']);
  });

  it('does not treat a commented-out \\section as a section', () => {
    const source = [
      '\\begin{document}',
      '\\section{Real}',
      'content',
      '% \\section{Fake}',
      '\\end{document}',
    ].join('\n');
    expect(resumeSectionNames(source)).toEqual(['Real']);
  });

  it('does not let an escaped percent start a comment', () => {
    // `\%` is a literal percent sign. If it were mistaken for a comment
    // starter, everything from it onward — including the closing brace and
    // the rest of the document — would be masked out, and the group would
    // never balance.
    const source =
      '\\begin{document}\\section{50\\% Off Sale}body\\end{document}';
    expect(resumeSectionNames(source)).toEqual(['50\\% Off Sale']);
  });

  it('ignores \\section mentioned only in the preamble', () => {
    // RESUME's preamble redefines \section via `\renewcommand\section{...}` —
    // unlike the bracketed `\renewcommand{\section}` form, this really is the
    // literal substring `\section{` (a control sequence with no braces around
    // it is valid \renewcommand syntax), and reads as a section — named after
    // the macro body itself — if the \begin{document} boundary is not honoured.
    const names = resumeSections(RESUME).map((s) => s.name);
    expect(names).toHaveLength(2);
    expect(names.some((n) => n.includes('startsection'))).toBe(false);
  });

  it('ignores \\section appearing after \\end{document}', () => {
    const names = resumeSections(RESUME).map((s) => s.name);
    expect(names).not.toContain('Scratch');
  });

  it('gives each section an end offset at the next section (or the document end)', () => {
    const sections = resumeSections(RESUME);
    const [education, experience] = sections;
    expect(education.end).toBe(experience.start);
    // Experience is the last section, so it runs up to \end{document}.
    expect(RESUME.slice(experience.end, experience.end + 14)).toBe('\\end{document}');
  });

  it('returns the same result on a second call — the shared /g regex must not leak lastIndex', () => {
    // resumeSections resets SECTION_COMMAND.lastIndex at the top of every
    // call. Without that reset, a source with a \section past \end{document}
    // leaves the shared, module-level regex's lastIndex pointing past the
    // document body after the first call (the loop `break`s on a *successful*
    // match once it passes `limit`, which — unlike an exhausted `exec()` — does
    // not auto-reset lastIndex to 0). A second call would then silently start
    // scanning from that leftover position instead of the real start, and lose
    // section(s) that come before it.
    const first = resumeSections(RESUME);
    const second = resumeSections(RESUME);
    expect(second).toEqual(first);
    expect(second.map((s) => s.name)).toEqual(['Education', 'Experience']);
  });
});

describe('findSection', () => {
  it('matches case- and whitespace-insensitively', () => {
    expect(findSection(RESUME, '  eXPERIENCE  ')?.name).toBe('Experience');
  });

  it('returns null for a name with no matching section', () => {
    expect(findSection(RESUME, 'Publications')).toBeNull();
  });
});

describe('insertResumeEntry — the insert-only invariant', () => {
  it('never removes or rewrites source text when appending to an existing section', () => {
    const entry = '\\resumeItem{Shipped the unique-marker-alpha widget}';
    const result = insertResumeEntry(RESUME, 'Experience', entry);

    // The insertion is documented as a pure splice: result equals the source
    // with exactly `\n\n${entry}\n` inserted at one offset, nothing removed.
    // Locate the entry, then strip exactly that wrapped run back out and
    // demand the two halves reconstruct the original source byte-for-byte.
    const entryIndex = result.indexOf(entry);
    expect(entryIndex).toBeGreaterThan(-1);
    const before = result.slice(0, entryIndex - 2); // strip the leading "\n\n"
    const after = result.slice(entryIndex + entry.length + 1); // strip the trailing "\n"
    expect(before + after).toBe(RESUME);
  });

  it('never removes or rewrites source text when creating a new section', () => {
    const entry = '\\resumeItem{Learned the unique-marker-beta framework}';
    const result = insertResumeEntry(RESUME, 'Projects', entry);

    const heading = '\\section{Projects}';
    const headingIndex = result.indexOf(heading);
    expect(headingIndex).toBeGreaterThan(-1);
    const entryIndex = result.indexOf(entry, headingIndex);
    expect(entryIndex).toBeGreaterThan(-1);

    const before = result.slice(0, headingIndex - 2); // strip the leading "\n\n"
    const after = result.slice(entryIndex + entry.length + 1); // strip the trailing "\n"
    expect(before + after).toBe(RESUME);
  });

  it('never removes or rewrites source text when the document has no \\end{document}', () => {
    const fragment = '\\section{Education}\nUniversity of Example';
    const entry = '\\resumeItem{Unique-marker-gamma}';
    const result = insertResumeEntry(fragment, 'Projects', entry);

    // Appending, not throwing, on a bare fragment.
    expect(result.startsWith(fragment)).toBe(true);
    expect(result).toContain('\\section{Projects}');
    expect(result).toContain(entry);
  });
});

describe('insertResumeEntry — placement', () => {
  it('appends to the END of an existing section, before the next \\section', () => {
    const entry = '\\resumeItem{New role at Acme}';
    const result = insertResumeEntry(RESUME, 'Education', entry);

    const educationIdx = result.indexOf('\\section{Education}');
    const experienceIdx = result.indexOf('\\section{Experience}');
    const entryIdx = result.indexOf(entry);

    expect(entryIdx).toBeGreaterThan(educationIdx);
    expect(entryIdx).toBeLessThan(experienceIdx);
    // And it lands after the section's own existing content, not shoved in
    // front of it.
    expect(entryIdx).toBeGreaterThan(result.indexOf('B.S. Computer Science'));
  });

  it('creates a new \\section before \\end{document} when the name does not exist', () => {
    const entry = '\\resumeItem{Built a personal site}';
    const result = insertResumeEntry(RESUME, 'Projects', entry);

    const heading = '\\section{Projects}';
    const headingIdx = result.indexOf(heading);
    const entryIdx = result.indexOf(entry);
    const endDocIdx = result.indexOf('\\end{document}');

    expect(headingIdx).toBeGreaterThan(-1);
    expect(entryIdx).toBeGreaterThan(headingIdx);
    expect(entryIdx).toBeLessThan(endDocIdx);
    // And it does not disturb the existing sections at all.
    expect(result.indexOf('\\section{Education}')).toBe(RESUME.indexOf('\\section{Education}'));
  });

  it('does not create a duplicate section when the target already exists', () => {
    const entry = '\\resumeItem{Another Acme bullet}';
    const result = insertResumeEntry(RESUME, 'Experience', entry);
    const names = resumeSectionNames(result);
    expect(names).toEqual(['Education', 'Experience']);
  });

  it('is a no-op for an empty (whitespace-only) entry', () => {
    expect(insertResumeEntry(RESUME, 'Experience', '   \n  ')).toBe(RESUME);
  });
});
