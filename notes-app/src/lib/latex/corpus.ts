/**
 * Choosing a past tailoring to start a new one from.
 *
 * The app keeps every resume it has successfully aimed at a job (the
 * `resume_targets` table). When you aim one at a *new* posting, this module
 * decides whether any of those is close enough to be worth something, and how
 * much: hand it back untouched, hand it to the model as precedent, or ignore the
 * corpus entirely and write from scratch as the app always did.
 *
 * Pure — no React, no database, no network — like `lib/resume-versions.ts` and
 * `lib/split-layout.ts`, so the judgement that decides whether someone's resume
 * gets rewritten can be tested directly rather than through a screen.
 *
 * ## Why there are no embeddings here
 *
 * The obvious way to find "the most similar prior posting" is a vector search,
 * and it is the wrong tool twice over. Anthropic has no embeddings API, so it
 * would mean a second provider and a second key — in an app that deliberately
 * bills each caller's own Anthropic key and has exactly one place
 * (`backend/app/ai_access.py`) that decides whose money is being spent. And the
 * thing an index buys you is sub-linear search, which matters at thousands of
 * rows; one person's corpus is dozens.
 *
 * What replaces it is an asymmetry worth understanding, because it is what makes
 * plain text matching work at all here. The *stored* side has already been read
 * by a model: when a tailoring is written, the same call that ranked this
 * person's experience against the posting also writes down what the posting
 * required, as short canonical keywords — "kubernetes", not "k8s"; "distributed
 * systems", not a sentence about them. So scoring a new posting is just asking
 * how many of a stored row's canonical requirements appear in the new posting's
 * own text. No model call, no latency, no spend, and it works offline.
 *
 * The honest limit: only one side is canonicalised. A new posting that says
 * "container orchestration" where the stored row says "kubernetes" scores zero
 * on that requirement, and a worse-fitting candidate that happens to share more
 * vocabulary can outrank a better one. That is the trade — and it is bounded by
 * the gate below, whose whole job is to make the failure "wrote from scratch
 * when it needn't have" rather than "started from the wrong resume".
 */
import type { ResumeFacets, ResumeTarget } from '@/data/notes';

/** Facets with nothing known — what a corrupt or absent blob reads as. */
export function emptyFacets(): ResumeFacets {
  return { roleFamily: '', seniority: '', sector: '', industry: '', requirements: [] };
}

/** What retrieval decided to do about a new posting. */
export type RetrievalTier =
  /** A stored tailoring is handed back unchanged. No model call at all. */
  | 'reuse'
  /** A stored tailoring goes up as precedent, and the model adapts it. */
  | 'adapt'
  /** Nothing close enough; tailor from scratch, exactly as before this existed. */
  | 'scratch';

/** The job being aimed at, as the tailor form has it. No model has read this. */
export type CorpusQuery = {
  /** The job title typed into the form. */
  role: string;
  /** The posting, pasted whole. */
  jobDescription: string;
  /**
   * Fingerprint of the resume as it stands right now. Compared against a stored
   * row's own fingerprint to decide whether reuse is even permissible.
   */
  sourceHash: string;
};

/**
 * Seniority, coarsest to finest, as an ordered ladder.
 *
 * The order is the point: adjacency is what `seniorityCloseness` measures, so
 * "mid" and "senior" being neighbours is data, not decoration. `''` (the posting
 * didn't say) is deliberately not on the ladder — an unknown is not a rung
 * between intern and junior.
 */
const SENIORITY_LADDER = [
  'intern',
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'lead',
] as const;

/**
 * Words that say *where in a career* a title sits rather than *what the job is*.
 *
 * Stripped out of a role before it is compared, because seniority is scored on
 * its own ladder and leaving it in the title would double-count it — "Senior
 * Backend Engineer" and "Backend Engineer" are the same family of work.
 */
const SENIORITY_WORDS: Record<string, (typeof SENIORITY_LADDER)[number]> = {
  intern: 'intern',
  internship: 'intern',
  'new grad': 'junior',
  graduate: 'junior',
  entry: 'junior',
  junior: 'junior',
  jr: 'junior',
  associate: 'junior',
  mid: 'mid',
  intermediate: 'mid',
  senior: 'senior',
  sr: 'senior',
  staff: 'staff',
  principal: 'principal',
  lead: 'lead',
  head: 'lead',
};

/**
 * Job-title words that mean the same work under different house styles.
 *
 * Deliberately tiny, and deliberately *not* a copy of the ~100-title reference
 * table in `backend/app/resume_roles.py`. That table is the server's, it is
 * curated, and duplicating it here would give two lists that drift. This is the
 * handful of pairs common enough that missing them would fail the gate on
 * postings a person would obviously call the same job.
 */
const ROLE_SYNONYMS: Record<string, string> = {
  developer: 'engineer',
  dev: 'engineer',
  programmer: 'engineer',
  engineering: 'engineer',
  swe: 'engineer',
  sde: 'engineer',
  ml: 'machine learning',
  ai: 'machine learning',
  frontend: 'front end',
  backend: 'back end',
  fullstack: 'full stack',
  devops: 'platform',
  sre: 'platform',
  infrastructure: 'platform',
  pm: 'product manager',
  qa: 'quality assurance',
};

/** Title words that carry no information about the work. */
const ROLE_NOISE = new Set([
  'i',
  'ii',
  'iii',
  'iv',
  'the',
  'a',
  'an',
  'of',
  'and',
  'for',
  'at',
  'in',
  'to',
  'position',
  'role',
  'job',
  'opening',
  'opportunity',
  'contract',
  'remote',
  'hybrid',
  'onsite',
  'time',
  'full',
  'part',
]);

/**
 * Lowercase, drop punctuation, collapse runs of whitespace.
 *
 * `.`, `+` and `#` survive *inside* a token because they are load-bearing in the
 * names this matches on — "node.js", "c++", "c#", ".net" are different things
 * from "node js" and "c". They are then trimmed from the *edges*, which is the
 * difference between a name and a sentence's punctuation.
 *
 * That trim is not cosmetic. Without it "Sr." stays "sr." and never matches the
 * `sr` seniority marker, so it is never stripped from a role — and since role
 * family is a hard gate in `similarity`, a stored tailoring for "Backend
 * Engineer" would score exactly 0 against a posting titled "Sr. Backend
 * Engineer". Every abbreviated title in the corpus would silently never match.
 */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[.]+/, '').replace(/[.]+$/, ''))
    .filter(Boolean);
}

/**
 * Where in a career ladder a job title sits, or `''` when it doesn't say.
 *
 * Reads the *first* seniority word rather than the last: "Senior Engineer,
 * Junior Team" is about a senior engineer, and titles put their own seniority
 * up front.
 */
export function seniorityOf(title: string): ResumeFacets['seniority'] {
  const text = ` ${title.toLowerCase()} `;
  // Multi-word markers first — "new grad" would otherwise be missed entirely,
  // since neither of its halves is a marker on its own.
  for (const [word, rank] of Object.entries(SENIORITY_WORDS)) {
    if (word.includes(' ') && text.includes(` ${word} `)) return rank;
  }
  for (const word of words(title)) {
    const rank = SENIORITY_WORDS[word];
    if (rank) return rank;
  }
  return '';
}

/**
 * The canonical bucket a job title belongs to: seniority stripped, synonyms
 * folded, noise dropped, and what's left sorted so word order can't split one
 * family in two ("Engineer, Backend" and "Backend Engineer" are one job).
 */
export function roleFamilyOf(title: string): string {
  const kept: string[] = [];
  for (const word of words(title)) {
    if (SENIORITY_WORDS[word] || ROLE_NOISE.has(word)) continue;
    kept.push(ROLE_SYNONYMS[word] ?? word);
  }
  // The synonym table maps some words to two-word phrases ("front end"), so the
  // result is re-split before sorting or those would sort as one long token.
  const flat = kept.join(' ').split(/\s+/).filter(Boolean);
  return Array.from(new Set(flat)).sort().join(' ');
}

/**
 * How much of what one posting required is asked for again by another, 0..1.
 *
 * Matched on word boundaries rather than bare `includes`, so "go" does not match
 * "going" and "r" does not match every word containing one — the short names
 * real requirement lists are full of are exactly where a substring test goes
 * wrong. A multi-word requirement is matched as a phrase.
 *
 * An empty requirement list scores 0, not 1: a row that recorded nothing has not
 * proved it matches, and treating "nothing to check" as a perfect score would
 * make the emptiest rows the most reusable.
 */
export function requirementOverlap(requirements: string[], posting: string): number {
  const wanted = requirements.map((r) => r.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return 0;
  const haystack = ` ${words(posting).join(' ')} `;
  let found = 0;
  for (const requirement of wanted) {
    const needle = ` ${words(requirement).join(' ')} `;
    if (needle.trim() && haystack.includes(needle)) found += 1;
  }
  return found / wanted.length;
}

/** Whether a stored row's industry or sector is named in the new posting. */
export function industryMatch(facets: ResumeFacets, posting: string): number {
  const haystack = ` ${words(posting).join(' ')} `;
  const named = [facets.industry, facets.sector].filter((v) => v.trim());
  if (named.length === 0) return 0;
  const hits = named.filter((v) => haystack.includes(` ${words(v).join(' ')} `));
  return hits.length / named.length;
}

/**
 * 1 for the same rung, 0.5 for neighbours, 0 further apart or unknown.
 *
 * A tie-breaker rather than a driver, because moving up a rung is usually the
 * *reason* someone is re-tailoring rather than a reason to rule a resume out.
 */
export function seniorityCloseness(
  a: ResumeFacets['seniority'],
  b: ResumeFacets['seniority'],
): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const distance = Math.abs(SENIORITY_LADDER.indexOf(a) - SENIORITY_LADDER.indexOf(b));
  return distance === 1 ? 0.5 : 0;
}

/**
 * Weights, summing to 1 so a score is a legible 0..1 rather than an arbitrary
 * total. Requirements dominate because they are the only term carrying anything
 * specific to *this posting* — the other two say what kind of job it is, which
 * the gate has already established.
 */
const WEIGHT_REQUIREMENTS = 0.7;
const WEIGHT_INDUSTRY = 0.2;
const WEIGHT_SENIORITY = 0.1;

/**
 * How much a stored tailoring has to say about a new posting, 0..1.
 *
 * **The role family is a hard gate, not a weighted term**, and that asymmetry is
 * deliberate. Two postings for genuinely different jobs share a surprising
 * amount of language — "fast-paced", "stakeholders", "communication", "Excel" —
 * and a weighted role term lets enough of that outvote it. Starting from the
 * wrong profession's resume is a far worse failure than writing one from
 * scratch, so a family mismatch scores zero outright and no amount of shared
 * vocabulary can rescue it.
 */
export function similarity(target: ResumeTarget, query: CorpusQuery): number {
  const family = target.facets.roleFamily || roleFamilyOf(target.role);
  if (!family || family !== roleFamilyOf(query.role)) return 0;
  return (
    WEIGHT_REQUIREMENTS * requirementOverlap(target.facets.requirements, query.jobDescription) +
    WEIGHT_INDUSTRY * industryMatch(target.facets, query.jobDescription) +
    WEIGHT_SENIORITY * seniorityCloseness(target.facets.seniority, seniorityOf(query.role))
  );
}

/**
 * At or above this, a stored tailoring is handed back untouched.
 *
 * Reaching 0.85 needs the requirement overlap alone to be near-total even with
 * industry and seniority both perfect (0.7 × 0.93 + 0.2 + 0.1 ≈ 0.85), which is
 * the arithmetic way of saying "these are the same job advertised twice". That
 * is the only case narrow enough to skip the model on, because the claim being
 * made is not "this LaTeX is fine" — it compiled once, it is always fine — but
 * "nothing about this posting needs a different argument made".
 *
 * Reasoned from the formula rather than measured, because there is no corpus yet
 * to measure against. It is meant to be tuned once real scores exist, and it is
 * meant to start too strict: an unnecessary model call costs a minute, and a
 * wrongly reused resume costs an application.
 */
export const REUSE_THRESHOLD = 0.85;

/**
 * At or above this, a stored tailoring is worth showing the model as precedent.
 *
 * 0.45 is roughly "same family, half the requirements recur, plus some industry
 * or seniority agreement" — enough shared shape to be a better starting point
 * than a blank page, nowhere near enough to trust without a rewrite.
 */
export const ADAPT_THRESHOLD = 0.45;

/** Which tier a score falls in, with both thresholds in one place. */
export function tierFor(score: number): RetrievalTier {
  if (score >= REUSE_THRESHOLD) return 'reuse';
  if (score >= ADAPT_THRESHOLD) return 'adapt';
  return 'scratch';
}

/** What retrieval found: a candidate, how good it is, and what to do with it. */
export type Retrieval = {
  target: ResumeTarget;
  score: number;
  tier: Exclude<RetrievalTier, 'scratch'>;
  /**
   * True when the candidate scored high enough to reuse but was demoted to
   * `adapt` because the resume has changed since it was written. The screen says
   * so out loud — "close match, but your resume has changed since" is a
   * different thing to be told than "close enough, here it is".
   */
  demotedByEdit: boolean;
};

/**
 * The best thing the corpus has to offer for one new posting, or `null` for
 * "nothing worth using — write from scratch".
 *
 * ## The staleness gate
 *
 * Reuse additionally requires that the resume has not changed since the stored
 * tailoring was written, and this is the one rule here that protects against a
 * failure nobody would notice. A stored document is a photograph of a resume on
 * one day. Hand it back verbatim after the person has added the job they started
 * last month, and they get a resume with their newest experience silently
 * missing — a mistake that surfaces in an interview, not on screen. So a
 * candidate whose `baseHash` no longer matches the document in hand can never be
 * reused; it drops to `adapt`, which is a model call that reads the resume as it
 * is now. Adapting is never gated this way, because adapting cannot go stale:
 * the current document is what the model answers against.
 *
 * ## Why a reusable candidate outranks a better-scoring one
 *
 * Candidates are ordered by tier first and only then by score, which is the one
 * place this function deliberately does not just take the highest number. A
 * candidate scoring 0.90 that has gone stale is worth *less* here than one
 * scoring 0.86 that has not: the first costs a minute of writing and the second
 * costs nothing, and both are above the bar that says the job is the same. Sorting
 * on score alone would let a stale near-miss quietly spend someone's Anthropic
 * budget to rewrite a resume that already existed.
 *
 * Within a tier, higher score wins, and ties break on recency — a newer tailoring
 * reflects a newer resume.
 */
export function bestRetrieval(corpus: ResumeTarget[], query: CorpusQuery): Retrieval | null {
  let best: Retrieval | null = null;
  for (const target of corpus) {
    const score = similarity(target, query);
    const tier = tierFor(score);
    if (tier === 'scratch') continue;
    // Stale means the document this was written against is not the document in
    // hand any more. It bars reuse and nothing else — adapting reads the current
    // resume, so it cannot inherit an out-of-date one.
    const stale = target.baseHash !== query.sourceHash;
    const demotedByEdit = tier === 'reuse' && stale;
    const settled: Retrieval = {
      target,
      score,
      tier: demotedByEdit ? 'adapt' : tier,
      demotedByEdit,
    };
    if (!best || outranks(settled, best)) best = settled;
  }
  return best;
}

/** Whether `a` is the better candidate: reusable first, then score, then recency. */
function outranks(a: Retrieval, b: Retrieval): boolean {
  if (a.tier !== b.tier) return a.tier === 'reuse';
  if (a.score !== b.score) return a.score > b.score;
  return a.target.createdAt > b.target.createdAt;
}

/**
 * A stable fingerprint of a resume's source.
 *
 * FNV-1a, which is not a cryptographic hash and does not need to be: nothing
 * here defends against someone crafting a collision, it only answers "is this
 * the same document I tailored last time". Whitespace is collapsed first so
 * reflowing a line — which changes no LaTeX — doesn't read as an edit.
 *
 * Written in TypeScript rather than taken from the server because the server
 * never sees it: the fingerprint is produced and compared entirely on the
 * device, so there is no second implementation to keep in step.
 */
export function fingerprintSource(source: string): string {
  const normalised = source.replace(/\s+/g, ' ').trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalised.length; i += 1) {
    hash ^= normalised.charCodeAt(i);
    // The FNV prime, as shifts: a plain `hash * 16777619` overflows a double's
    // exact-integer range and starts losing low bits, which is where a hash that
    // looks fine quietly stops distinguishing documents.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
