/**
 * Cache names for compiled resumes.
 *
 * This is the whole invalidation story for the PDF cache, so its failure modes
 * are the quiet kind: a name that doesn't change when the LaTeX does shows the
 * previous resume forever, and a name that changes when the LaTeX hasn't
 * silently recompiles every open — the thing the cache exists to stop. Neither
 * throws, and both look fine in a screenshot.
 */
import { describe, expect, it } from 'vitest';

import { fingerprint, pdfCacheName, pdfCachePrefix } from '@/lib/latex/pdf-cache-key';

const SOURCE = '\\documentclass{article}\\begin{document}Riley\\end{document}';

describe('pdfCacheName', () => {
  it('is the same for the same source, so reopening a resume is a hit', () => {
    expect(pdfCacheName('note-1', 'pdflatex', SOURCE)).toBe(pdfCacheName('note-1', 'pdflatex', SOURCE));
  });

  it('changes when the source changes by one character', () => {
    expect(pdfCacheName('note-1', 'pdflatex', SOURCE)).not.toBe(pdfCacheName('note-1', 'pdflatex', `${SOURCE} `));
  });

  it('keeps two resumes apart even with identical source', () => {
    expect(pdfCacheName('note-1', 'pdflatex', SOURCE)).not.toBe(pdfCacheName('note-2', 'pdflatex', SOURCE));
  });

  // The engine is half of what produced the PDF: the same LaTeX under pdfLaTeX
  // and XeLaTeX differs in font and page count, which is the entire reason both
  // are offered. Keyed on source alone, switching engine would serve the other
  // one's PDF straight back and look like the switch did nothing.
  it('keeps the engines apart for identical source', () => {
    expect(pdfCacheName('note-1', 'pdflatex', SOURCE)).not.toBe(
      pdfCacheName('note-1', 'xelatex', SOURCE),
    );
  });

  // The note id goes through a filename sanitiser, so ids differing only in
  // characters it strips would collide on the sanitised part alone — one
  // resume's PDF would surface in the other.
  it('keeps ids apart when they sanitise to the same filename', () => {
    expect(pdfCacheName('a/b', 'pdflatex', SOURCE)).not.toBe(pdfCacheName('a:b', 'pdflatex', SOURCE));
  });

  it('is safe to use as a filename and as a URL path segment', () => {
    expect(pdfCacheName('a/b c:d?e', 'pdflatex', SOURCE)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  // Eviction finds a resume's older entries by prefix; if the name didn't start
  // with it, every compile would leave its predecessor behind for good.
  it('starts with the resume prefix that eviction scans for', () => {
    expect(pdfCacheName('note-1', 'pdflatex', SOURCE).startsWith(pdfCachePrefix('note-1'))).toBe(true);
  });

  it('does not carry another resume prefix', () => {
    expect(pdfCacheName('note-1', 'pdflatex', SOURCE).startsWith(pdfCachePrefix('note-2'))).toBe(false);
  });
});

describe('fingerprint', () => {
  it('separates sources of the same length', () => {
    expect(fingerprint('aaaa')).not.toBe(fingerprint('aaab'));
  });

  it('separates a source from its own prefix', () => {
    expect(fingerprint('\\section{A}')).not.toBe(fingerprint('\\section{A}\\section{B}'));
  });

  it('separates transpositions, which a summing hash would miss', () => {
    expect(fingerprint('ab')).not.toBe(fingerprint('ba'));
  });

  it('handles an empty string without producing a name-breaking value', () => {
    expect(fingerprint('')).toMatch(/^[a-z0-9]+$/);
  });
});
