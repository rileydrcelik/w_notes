/**
 * Resume notes are the one plugin note type that still stores raw source
 * (LaTeX) in `body` instead of the app's canonical rich-text HTML. These
 * helpers are what keeps that source out of the rich-text pipeline and turns
 * it into filenames/previews, so they're worth pinning down directly.
 */
import { describe, expect, it } from 'vitest';

import type { Note } from '@/data/notes';
import {
  isResumeNote,
  resumeConfigWithMasterVersion,
  resumeMasterVersionId,
  resumePdfFileName,
  resumeSourceExcerpt,
  resumeTitle,
} from '@/lib/resume-note';

describe('isResumeNote', () => {
  it('is true only for pluginType "resume"', () => {
    expect(isResumeNote({ pluginType: 'resume' })).toBe(true);
  });

  it('is false for other plugin types and for plain notes', () => {
    expect(isResumeNote({ pluginType: 'sentry' })).toBe(false);
    expect(isResumeNote({ pluginType: undefined })).toBe(false);
    expect(isResumeNote({} as Pick<Note, 'pluginType'>)).toBe(false);
  });
});

describe('resumeTitle', () => {
  it('uses the title', () => {
    expect(resumeTitle({ title: 'Backend Engineer' })).toBe('Backend Engineer');
  });

  it('falls back for an empty or whitespace-only title', () => {
    expect(resumeTitle({ title: '' })).toBe('Untitled resume');
    expect(resumeTitle({ title: '   ' })).toBe('Untitled resume');
  });

  it('trims surrounding whitespace', () => {
    expect(resumeTitle({ title: '  Jane Doe  ' })).toBe('Jane Doe');
  });
});

describe('resumePdfFileName', () => {
  it('appends .pdf to the title', () => {
    expect(resumePdfFileName({ title: 'Jane Doe' })).toBe('Jane Doe.pdf');
  });

  it('strips characters that are illegal in filenames', () => {
    expect(resumePdfFileName({ title: 'a/b\\c:d*e?f"g<h>i|j' })).toBe('abcdefghij.pdf');
  });

  it('collapses whitespace left behind by stripping', () => {
    expect(resumePdfFileName({ title: 'a  /  b' })).toBe('a b.pdf');
  });

  it('falls back to "resume" when the title is nothing but illegal characters', () => {
    expect(resumePdfFileName({ title: '///' })).toBe('resume.pdf');
  });

  it('falls back to "Untitled resume" for an empty title', () => {
    expect(resumePdfFileName({ title: '' })).toBe('Untitled resume.pdf');
  });

  it('clamps to 80 characters', () => {
    const name = resumePdfFileName({ title: 'x'.repeat(200) });
    expect(name).toBe(`${'x'.repeat(80)}.pdf`);
  });
});

describe('resumeSourceExcerpt', () => {
  it('skips comments and preamble commands, keeping content lines', () => {
    const source = [
      '% a comment about the template',
      '\\documentclass[letterpaper,11pt]{article}',
      '\\usepackage{enumitem}',
      '\\titleformat{\\section}{\\large\\bfseries}{}{0em}{}',
      '\\begin{document}',
      '\\section{Experience}',
      '\\textbf{Job Title} \\hfill 2024--Present',
    ].join('\n');

    expect(resumeSourceExcerpt(source)).toBe(
      '\\section{Experience}\n\\textbf{Job Title} \\hfill 2024--Present',
    );
  });

  it('skips blank lines', () => {
    const source = '\\section{Experience}\n\n\ntext line';
    expect(resumeSourceExcerpt(source)).toBe('\\section{Experience}\ntext line');
  });

  it('respects maxLines', () => {
    const source = ['one', 'two', 'three', 'four', 'five'].join('\n');
    expect(resumeSourceExcerpt(source, 2)).toBe('one\ntwo');
  });

  it('returns an empty string when the source is only comments/preamble', () => {
    const source = '% just a comment\n\\documentclass{article}\n\\usepackage{geometry}';
    expect(resumeSourceExcerpt(source)).toBe('');
  });

  it('trims each kept line', () => {
    const source = '   \\section{Experience}   \n   indented content   ';
    expect(resumeSourceExcerpt(source)).toBe('\\section{Experience}\nindented content');
  });
});

/**
 * The master-version pointer shares `pluginConfig` with the engine and the
 * current version. The expensive mistake here isn't reading it wrong — it's a
 * writer that rebuilds the object and drops the keys it didn't know about,
 * which is how the finance sheet lost data. So the preservation cases carry as
 * much weight as the round trip.
 */
describe('resumeMasterVersionId', () => {
  const resume = (
    pluginConfig?: string,
  ): Pick<Note, 'pluginType' | 'pluginConfig'> => ({
    pluginType: 'resume',
    pluginConfig,
  });

  it('reads the stored pointer', () => {
    expect(resumeMasterVersionId(resume('{"masterVersionId":"ver-7"}'))).toBe('ver-7');
  });

  it('is null when no master has been chosen', () => {
    expect(resumeMasterVersionId(resume('{"engine":"xelatex"}'))).toBe(null);
    expect(resumeMasterVersionId(resume())).toBe(null);
  });

  it('is null for a corrupt config rather than throwing', () => {
    expect(resumeMasterVersionId(resume('{not json'))).toBe(null);
  });

  it('is null for a non-string or empty pointer', () => {
    expect(resumeMasterVersionId(resume('{"masterVersionId":42}'))).toBe(null);
    expect(resumeMasterVersionId(resume('{"masterVersionId":""}'))).toBe(null);
  });

  it('is null on a note that is not a resume, whatever its config says', () => {
    expect(
      resumeMasterVersionId({ pluginType: 'sentry', pluginConfig: '{"masterVersionId":"ver-7"}' }),
    ).toBe(null);
  });
});

describe('resumeConfigWithMasterVersion', () => {
  it('sets the pointer', () => {
    const written = resumeConfigWithMasterVersion({}, 'ver-7');
    expect(JSON.parse(written)).toEqual({ masterVersionId: 'ver-7' });
  });

  it('keeps every other key — the engine and the current version live here too', () => {
    const written = resumeConfigWithMasterVersion(
      { pluginConfig: '{"engine":"xelatex","versionId":"ver-2"}' },
      'ver-7',
    );
    expect(JSON.parse(written)).toEqual({
      engine: 'xelatex',
      versionId: 'ver-2',
      masterVersionId: 'ver-7',
    });
  });

  it('keeps a key it has never heard of', () => {
    const written = resumeConfigWithMasterVersion({ pluginConfig: '{"fromTheFuture":1}' }, 'ver-7');
    expect(JSON.parse(written)).toEqual({ fromTheFuture: 1, masterVersionId: 'ver-7' });
  });

  it('clears the pointer for null, leaving the rest alone', () => {
    const written = resumeConfigWithMasterVersion(
      { pluginConfig: '{"engine":"pdflatex","masterVersionId":"ver-7"}' },
      null,
    );
    expect(JSON.parse(written)).toEqual({ engine: 'pdflatex' });
  });

  it('replaces a corrupt config rather than propagating it', () => {
    const written = resumeConfigWithMasterVersion({ pluginConfig: '{not json' }, 'ver-7');
    expect(JSON.parse(written)).toEqual({ masterVersionId: 'ver-7' });
  });

  it('replaces a config that is valid JSON but not an object', () => {
    const written = resumeConfigWithMasterVersion({ pluginConfig: '[1,2,3]' }, 'ver-7');
    expect(JSON.parse(written)).toEqual({ masterVersionId: 'ver-7' });
  });
});
