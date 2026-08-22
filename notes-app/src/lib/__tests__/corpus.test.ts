import { describe, expect, it } from 'vitest';

import type { ResumeFacets, ResumeTarget } from '@/data/notes';
import {
  ADAPT_THRESHOLD,
  REUSE_THRESHOLD,
  bestRetrieval,
  emptyFacets,
  fingerprintSource,
  industryMatch,
  requirementOverlap,
  roleFamilyOf,
  seniorityCloseness,
  seniorityOf,
  similarity,
  tierFor,
} from '@/lib/latex/corpus';

const facets = (overrides: Partial<ResumeFacets> = {}): ResumeFacets => ({
  ...emptyFacets(),
  ...overrides,
});

const target = (overrides: Partial<ResumeTarget> = {}): ResumeTarget => ({
  id: 'target-1',
  noteId: 'note-1',
  folderId: null,
  company: 'Acme',
  role: 'Backend Engineer',
  facets: facets({ roleFamily: 'back end engineer', requirements: ['kubernetes'] }),
  jobDescription: 'we need kubernetes experience',
  source: '\\documentclass{article}',
  baseHash: 'hash-a',
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
});

describe('emptyFacets', () => {
  it('is what a corrupt or absent facets blob reads as', () => {
    expect(emptyFacets()).toEqual({
      roleFamily: '',
      seniority: '',
      sector: '',
      industry: '',
      requirements: [],
    });
  });
});

describe('seniorityOf', () => {
  it('reads a single-word marker', () => {
    expect(seniorityOf('Senior Backend Engineer')).toBe('senior');
  });

  it('reads a multi-word marker that neither half alone would catch', () => {
    // Neither "new" nor "grad" alone is a marker in SENIORITY_WORDS.
    expect(seniorityOf('New Grad Software Engineer')).toBe('junior');
  });

  it('takes the first marker when a title contains more than one', () => {
    expect(seniorityOf('Senior Engineer, Junior Team Lead')).toBe('senior');
  });

  it('is empty when the title says nothing about seniority', () => {
    expect(seniorityOf('Backend Engineer')).toBe('');
  });

  it('reads "Sr." with the trailing period real titles use', () => {
    // words() keeps '.' inside a token (for "node.js", "c#", etc.) but must
    // still trim it off the edges, or "sr." never equals the "sr" marker.
    expect(seniorityOf('Sr. Backend Engineer')).toBe('senior');
  });
});

describe('roleFamilyOf', () => {
  it('folds word order and synonyms to the same family', () => {
    const a = roleFamilyOf('Backend Engineer');
    const b = roleFamilyOf('Engineer, Backend');
    const c = roleFamilyOf('Sr. Back-End Developer II');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('produces a different family for a genuinely different job', () => {
    expect(roleFamilyOf('Backend Engineer')).not.toBe(roleFamilyOf('Product Manager'));
  });
});

describe('requirementOverlap', () => {
  it('matches a requirement as a whole word, not a substring', () => {
    // "go" must not match inside "going".
    expect(requirementOverlap(['go'], 'we are going places')).toBe(0);
    expect(requirementOverlap(['go'], 'must know go and sql')).toBe(1);
  });

  it('matches a multi-word requirement as a phrase', () => {
    expect(
      requirementOverlap(['distributed systems'], 'experience with distributed systems required'),
    ).toBe(1);
    expect(
      requirementOverlap(['distributed systems'], 'systems that are distributed across nodes'),
    ).toBe(0);
  });

  it('scores an empty requirement list as 0, not 1', () => {
    expect(requirementOverlap([], 'anything at all')).toBe(0);
  });

  it('averages over multiple requirements', () => {
    expect(
      requirementOverlap(['go', 'rust', 'kubernetes'], 'we use go and kubernetes'),
    ).toBeCloseTo(2 / 3);
  });
});

describe('industryMatch', () => {
  it('is 0 when the row named no industry or sector', () => {
    expect(industryMatch(facets(), 'a payments company')).toBe(0);
  });

  it('is 1 when the named industry appears in the posting', () => {
    expect(industryMatch(facets({ industry: 'payments' }), 'a payments company')).toBe(1);
  });

  it('is a fraction when only one of two named terms appears', () => {
    expect(
      industryMatch(facets({ industry: 'payments', sector: 'finance' }), 'a payments company'),
    ).toBe(0.5);
  });
});

describe('seniorityCloseness', () => {
  it('is 1 for the same rung', () => {
    expect(seniorityCloseness('senior', 'senior')).toBe(1);
  });

  it('is 0.5 for adjacent rungs', () => {
    expect(seniorityCloseness('mid', 'senior')).toBe(0.5);
  });

  it('is 0 for rungs further apart', () => {
    expect(seniorityCloseness('junior', 'staff')).toBe(0);
  });

  it('is 0 when either side is unknown', () => {
    expect(seniorityCloseness('', 'senior')).toBe(0);
    expect(seniorityCloseness('senior', '')).toBe(0);
  });
});

describe('similarity', () => {
  it('is a hard gate: a role-family mismatch scores 0 despite total requirement overlap', () => {
    const t = target({
      role: 'Backend Engineer',
      facets: facets({ roleFamily: 'back end engineer', requirements: ['kubernetes', 'go'] }),
    });
    const score = similarity(t, {
      role: 'Product Manager',
      jobDescription: 'must know kubernetes and go',
      sourceHash: 'hash-a',
    });
    expect(score).toBe(0);
  });

  it('scores above 0 for the same role family with matching requirements', () => {
    const t = target({
      role: 'Backend Engineer',
      facets: facets({ roleFamily: 'back end engineer', requirements: ['kubernetes'] }),
    });
    const score = similarity(t, {
      role: 'Backend Engineer',
      jobDescription: 'must know kubernetes',
      sourceHash: 'hash-a',
    });
    expect(score).toBeGreaterThan(0);
  });
});

describe('tierFor', () => {
  it('is reuse at or above the reuse threshold', () => {
    expect(tierFor(REUSE_THRESHOLD)).toBe('reuse');
  });

  it('is adapt at or above the adapt threshold but below reuse', () => {
    expect(tierFor(ADAPT_THRESHOLD)).toBe('adapt');
    expect(tierFor(REUSE_THRESHOLD - 0.01)).toBe('adapt');
  });

  it('is scratch below the adapt threshold', () => {
    expect(tierFor(ADAPT_THRESHOLD - 0.01)).toBe('scratch');
  });
});

describe('bestRetrieval — the staleness gate', () => {
  const highScoringTarget = (overrides: Partial<ResumeTarget> = {}) =>
    target({
      role: 'Backend Engineer',
      facets: facets({
        roleFamily: 'back end engineer',
        requirements: ['kubernetes', 'distributed systems', 'go'],
        industry: 'payments',
        seniority: 'senior',
      }),
      baseHash: 'hash-current',
      createdAt: 1_000,
      ...overrides,
    });

  const query = {
    role: 'Senior Backend Engineer',
    // No requirement word sits at the end of a sentence: the tokenizer keeps a
    // trailing "." as part of the word (so LaTeX-ish tokens like "3.5" survive
    // intact), which means a word immediately before a period — "go." — will
    // not satisfy a word-boundary match against "go". That's a real corner of
    // the tokenizer, not something these staleness tests are trying to probe,
    // so the fixture avoids it to isolate the behaviour under test.
    jobDescription: 'must know kubernetes, distributed systems, and go for a payments company',
    sourceHash: 'hash-current',
  };

  it('returns reuse untouched when the base hash matches the current source', () => {
    const result = bestRetrieval([highScoringTarget()], query);
    expect(result?.tier).toBe('reuse');
    expect(result?.demotedByEdit).toBe(false);
  });

  it('demotes a would-be reuse candidate to adapt when the resume has since changed', () => {
    const result = bestRetrieval([highScoringTarget({ baseHash: 'hash-stale' })], query);
    expect(result?.tier).toBe('adapt');
    expect(result?.demotedByEdit).toBe(true);
  });

  it('never returns tier "reuse" for a stale candidate, no matter how it is scored', () => {
    const result = bestRetrieval([highScoringTarget({ baseHash: 'anything-else' })], query);
    expect(result?.tier).not.toBe('reuse');
  });

  it('does not demote a merely-adapt-tier candidate for being stale (staleness only bites reuse)', () => {
    const weaker = target({
      role: 'Backend Engineer',
      facets: facets({ roleFamily: 'back end engineer', requirements: ['kubernetes'] }),
      jobDescription: 'must know kubernetes',
      baseHash: 'hash-stale',
    });
    const result = bestRetrieval([weaker], {
      role: 'Backend Engineer',
      jobDescription: 'must know kubernetes',
      sourceHash: 'hash-current',
    });
    expect(result?.tier).toBe('adapt');
    expect(result?.demotedByEdit).toBe(false);
  });
});

describe('bestRetrieval — ties and selection', () => {
  it('breaks a tie on recency, preferring the newer candidate', () => {
    const older = target({ id: 'older', createdAt: 1_000, baseHash: 'hash-current' });
    const newer = target({ id: 'newer', createdAt: 2_000, baseHash: 'hash-current' });
    const result = bestRetrieval([older, newer], {
      role: 'Backend Engineer',
      jobDescription: 'we need kubernetes experience',
      sourceHash: 'hash-current',
    });
    expect(result?.target.id).toBe('newer');
  });

  it('returns null when nothing clears the scratch tier', () => {
    const result = bestRetrieval([target({ role: 'Product Manager' })], {
      role: 'Backend Engineer',
      jobDescription: 'anything',
      sourceHash: 'hash-current',
    });
    expect(result).toBeNull();
  });

  it('returns null for an empty corpus', () => {
    expect(
      bestRetrieval([], { role: 'Backend Engineer', jobDescription: '', sourceHash: 'x' }),
    ).toBeNull();
  });

  it('prefers a genuine (lower-scoring) reuse candidate over a higher-raw-scoring stale one', () => {
    // staleButHighScoring's raw score (1.0) beats genuineReuse's (0.9), so a
    // comparator that sorted on score alone would wrongly pick the stale one.
    // Once demoted for staleness it must lose to any real 'reuse' candidate,
    // however much lower that candidate scored.
    const staleButHighScoring = target({
      id: 'stale-high',
      role: 'Senior Backend Engineer',
      facets: facets({
        roleFamily: 'back end engineer',
        requirements: ['kubernetes', 'distributed systems', 'go'],
        industry: 'payments',
        seniority: 'senior',
      }),
      baseHash: 'hash-old',
    });
    const genuineReuse = target({
      id: 'fresh-reuse',
      role: 'Senior Backend Engineer',
      facets: facets({
        roleFamily: 'back end engineer',
        requirements: ['kubernetes'],
        industry: 'payments',
        // A second named term that the posting never mentions, so
        // industryMatch lands on 0.5 rather than 1 and this candidate's raw
        // score (0.9) stays below the stale candidate's (1.0).
        sector: 'a sector nobody mentions',
        seniority: 'senior',
      }),
      baseHash: 'hash-current',
    });
    const query = {
      role: 'Senior Backend Engineer',
      jobDescription: 'must know kubernetes, distributed systems, and go for a payments company',
      sourceHash: 'hash-current',
    };

    // Sanity-check the scores this test relies on before trusting the outcome.
    expect(similarity(staleButHighScoring, query)).toBeCloseTo(1.0);
    expect(similarity(genuineReuse, query)).toBeCloseTo(0.9);

    const result = bestRetrieval([staleButHighScoring, genuineReuse], query);
    expect(result?.target.id).toBe('fresh-reuse');
    expect(result?.tier).toBe('reuse');
  });
});

describe('fingerprintSource', () => {
  it('is whitespace-insensitive: reflowing a line is not an edit', () => {
    const a = fingerprintSource('line one\nline two   with extra   spaces');
    const b = fingerprintSource('line one line two with extra spaces');
    expect(a).toBe(b);
  });

  it('distinguishes genuinely different documents', () => {
    expect(fingerprintSource('resume A')).not.toBe(fingerprintSource('resume B'));
  });
});
