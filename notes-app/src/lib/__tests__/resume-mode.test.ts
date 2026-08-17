/**
 * Which pane the resume screen opens on.
 *
 * The read-only rule is the one worth pinning. Mobile has no LaTeX editor — no
 * touch keyboard over a monospace document, no authoring toolbar — and the way
 * that used to be "true" was an accident: `supported` ANDed "the server can
 * compile" with "this platform can draw a PDF", so native compiled nothing,
 * previewed nothing and had nothing to download, while still opening an *empty*
 * resume straight into a source field.
 *
 * A regression would put that field back, and only for an empty resume — the
 * case nobody screenshots.
 */

import { describe, expect, it } from 'vitest';

import { openingResumeMode } from '@/lib/resume-mode';

describe('openingResumeMode', () => {
  describe('read-only (mobile)', () => {
    it.each([
      ['a written resume', '\\documentclass{article}'],
      ['an empty resume', ''],
      ['a whitespace-only resume', '   \n\t '],
      ['a resume with no body at all', undefined],
    ])('opens %s in the read view', (_label, body) => {
      expect(openingResumeMode(body, true)).toBe('view');
    });
  });

  describe('editable (web)', () => {
    it('opens a written resume in its read view, like any document', () => {
      expect(openingResumeMode('\\documentclass{article}', false)).toBe('view');
    });

    it('opens a blank resume in the editor, so there is somewhere to start', () => {
      expect(openingResumeMode('', false)).toBe('edit');
    });

    it('treats whitespace as blank — a file of newlines is not a document', () => {
      expect(openingResumeMode('   \n\t ', false)).toBe('edit');
    });

    it('opens a resume with no body at all in the editor', () => {
      expect(openingResumeMode(undefined, false)).toBe('edit');
    });
  });
});
