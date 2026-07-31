/**
 * Applying an edit to a resume.
 *
 * Adding an entry is insert-only, and that is the whole safety story there:
 * whatever the model returns, the only thing that happens to an existing
 * document is a run of text appearing at one offset. Editing cannot work that
 * way — something existing has to change — so the property is narrowed instead
 * of abandoned: the model must **quote** what it wants replaced, and that quote
 * is applied literally.
 *
 * These pin the literal part. A near-match must not be made to fit, a quote
 * matching twice must not resolve to "the first one", and everything outside
 * the replaced span must survive byte-for-byte.
 */
import { describe, expect, it } from 'vitest';

import { replaceResumeEntry } from '@/lib/latex/sections';

const RESUME = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Experience}',
  '  \\resumeSubheading{Backend Engineer}{2022 -- 2024}{Globex}{Remote}',
  '  \\resumeItem{Cut p99 latency 38\\% by replacing the pricing cache.}',
  '\\section{Projects}',
  '  \\resumeItem{Built a thing.}',
  '\\end{document}',
].join('\n');

describe('replaceResumeEntry', () => {
  it('replaces the quoted run and leaves everything else byte-identical', () => {
    const old = '  \\resumeItem{Cut p99 latency 38\\% by replacing the pricing cache.}';
    const next = '  \\resumeItem{Cut p99 latency 38\\% by rewriting the pricing cache in Rust.}';

    const result = replaceResumeEntry(RESUME, old, next);
    if (!result.ok) throw new Error(`expected a replacement, got ${result.reason}`);

    expect(result.source).toContain('rewriting the pricing cache in Rust');
    // The rest of the document is untouched — same preamble, same other section.
    expect(result.source.replace(next, old)).toBe(RESUME);
  });

  it('refuses a quote that is not present rather than finding the nearest thing', () => {
    // A single interior word changed — the sort of thing that happens when a
    // quote is retyped from memory instead of copied. Absorbing it would mean
    // applying an edit against text nobody actually verified.
    const retyped = '\\resumeItem{Cut p99 latency 38\\% by replacing the pricing caches.}';
    expect(replaceResumeEntry(RESUME, retyped, 'anything')).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('is plain substring matching, so a quote may omit surrounding indentation', () => {
    // Worth stating rather than discovering: matching is `indexOf`, so a quote
    // that drops the leading spaces still matches — inside the indented line.
    // The consequence is benign and mildly good: the replacement lands in the
    // narrower span and the original indentation survives untouched.
    const unindented = '\\resumeItem{Cut p99 latency 38\\% by replacing the pricing cache.}';
    const result = replaceResumeEntry(RESUME, unindented, '\\resumeItem{Shorter.}');
    if (!result.ok) throw new Error(`expected a replacement, got ${result.reason}`);
    expect(result.source).toContain('  \\resumeItem{Shorter.}');
  });

  it('refuses a quote that matches twice rather than picking the first', () => {
    const twice = ['\\resumeItem{Same bullet.}', '\\resumeItem{Same bullet.}'].join('\n');
    expect(replaceResumeEntry(twice, '\\resumeItem{Same bullet.}', 'x')).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
  });

  it('refuses an empty quote, which would otherwise match at offset zero', () => {
    // `indexOf('')` is 0, so without this an empty quote would splice the
    // replacement onto the front of the document.
    expect(replaceResumeEntry(RESUME, '', 'x')).toEqual({ ok: false, reason: 'empty' });
  });

  it('replaces a genuinely unique quote without tripping the ambiguity check', () => {
    const result = replaceResumeEntry('aXa', 'X', 'Y');
    if (!result.ok) throw new Error('expected a replacement');
    expect(result.source).toBe('aYa');
  });

  it('treats a self-overlapping quote as ambiguous', () => {
    // "\n\n" matches at two offsets inside "\n\n\n", and replacing at each
    // gives a different document — so it is ambiguous even though a
    // non-overlapping count would say it appears once. This is the case that
    // distinguishes stepping by one from stepping by the quote's length, and
    // it is reachable: a model quoting a blank-line-delimited span produces
    // exactly this shape.
    expect(replaceResumeEntry('a\n\n\nb', '\n\n', 'X')).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
  });

  it('can replace a span that ends the document', () => {
    const result = replaceResumeEntry(RESUME, '\\end{document}', '\\end{document}\n');
    if (!result.ok) throw new Error('expected a replacement');
    expect(result.source.endsWith('\\end{document}\n')).toBe(true);
  });

  it('allows an empty replacement, which is how a bullet gets deleted', () => {
    const old = '  \\resumeItem{Built a thing.}\n';
    const result = replaceResumeEntry(RESUME, old, '');
    if (!result.ok) throw new Error('expected a replacement');
    expect(result.source).not.toContain('Built a thing');
    expect(result.source).toContain('\\section{Projects}');
  });
});
