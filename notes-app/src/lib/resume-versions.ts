/**
 * A resume's version history: what each snapshot is called, and what order they
 * read in.
 *
 * Pure — no React, no database, no network — so the naming and ordering rules can
 * be tested directly, the way `lib/latex/sections.ts` and `lib/split-layout.ts`
 * are. The side effects (appending a snapshot, restoring one) live with the
 * screen that owns the document; see `app/(home)/resume/[id].tsx`.
 *
 * Two rules matter more than they look:
 *
 * - **A label is frozen when the snapshot is written.** The oldest snapshot is
 *   labelled with the resume's title *as it was then*, not read live from the
 *   note. Deriving it live would mean renaming a resume silently rewrote its own
 *   history — the entry for "what this document was before I started" would keep
 *   changing its mind about what that document was called.
 * - **The model names its own change.** Both `/resume/entry` and `/resume/edit`
 *   return a `summary` alongside the LaTeX, so the label costs no extra round
 *   trip. The fallbacks below are for the case where it comes back empty, which
 *   the schema makes close to unreachable — but a missing caption must never cost
 *   someone the change it was captioning, so there is always a local answer.
 */
import type { Note, ResumeVersion } from '@/data/notes';
import type { ResumeEditDraft, ResumeEntryDraft } from '@/lib/latex/entry';
import type { HardenDraft } from '@/lib/latex/harden';
import type { TailorDraft } from '@/lib/latex/tailor';
import { resumeTitle } from '@/lib/resume-note';

/**
 * Longest label the history will store.
 *
 * Deliberately the same 80 as `_MAX_SUMMARY_CHARS` in
 * `backend/app/routers/resume.py`, which clamps the model's own summary. Two
 * implementations of one rule, because they sit either side of the Python/TS
 * boundary and can't share code — if you change one, change both, or a
 * server-written label and a locally-derived one stop looking alike in the list.
 */
export const MAX_LABEL_CHARS = 80;

/**
 * A label short enough for a list row, cut on a word boundary where there is
 * one. Also collapses whitespace: a label derived from a multi-line instruction
 * field would otherwise carry newlines into a single-line row.
 */
export function truncateLabel(text: string, max = MAX_LABEL_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const boundary = cut.lastIndexOf(' ');
  // `boundary > 0`, not `>= 0`: at -1 there is no space at all, and `slice(0, -1)`
  // would quietly drop the last character instead of falling through to the hard
  // cut below — which is exactly the bug the tests for this caught. Python's
  // `rsplit` returns the whole string in that case, so the backend's twin of this
  // function (`_label`) does not share the hazard.
  const spaced = boundary > 0 ? cut.slice(0, boundary) : '';
  // A single word longer than the cap has no boundary to fall back to; and a
  // boundary in the first half would throw away more than it saves.
  return `${(spaced.length >= max / 2 ? spaced : cut).trimEnd()}…`;
}

/**
 * What the first snapshot is called: the resume's own title.
 *
 * This is the row that answers "what did this look like before any of this?", so
 * it reads as the document rather than as a change — and it uses the same
 * "Untitled resume" fallback the header and the PDF filename use, so an untitled
 * resume doesn't get a third name for itself here.
 */
export function originalLabel(note: Pick<Note, 'title'>): string {
  return truncateLabel(resumeTitle(note));
}

/**
 * What a tailored version is called: the job it is aimed at, and nothing else.
 *
 * "Acme — Senior Backend Engineer". Weeks later, with four tailored versions in
 * the list, the only question being asked of these labels is which job each one
 * was for — so they are the answer to that and carry no other words. Dropping the
 * "Tailored for" prefix also lets the company sit at the start of the row, which
 * is what the eye scans a list by.
 *
 * Built here rather than taken from the model, so every tailored version has the
 * same shape and the list stays scannable.
 */
export function describeTailorTarget(draft: Pick<TailorDraft, 'company' | 'role'>): string {
  const company = draft.company.trim();
  const role = draft.role.trim();
  // Either half alone still names the job; the separator only earns its place
  // when there is something on both sides of it.
  const target = [company, role].filter(Boolean).join(' — ');
  return truncateLabel(target || 'Tailored resume');
}

/**
 * What a hardened version is called: the job title it was built against.
 *
 * "Hardened — Data Engineer". The prefix earns its place here where it doesn't on
 * a tailored version, because a bare job title in the list would be ambiguous
 * with one: a tailored row is "Acme — Senior Backend Engineer" and a hardened one
 * has no company to put in front of the title, so without the word the two kinds
 * of row would be told apart only by whether they happen to have a dash in them.
 */
export function describeHardenTarget(draft: Pick<HardenDraft, 'role'>): string {
  const role = draft.role.trim();
  return truncateLabel(role ? `Hardened — ${role}` : 'Hardened resume');
}

/**
 * Whether a version matches what someone typed into the history's search box.
 *
 * Matches the label and the document text both. The label answers "which job was
 * this for"; the text answers "which version still had the Globex role in it",
 * which is the other question people actually have about a history and the one a
 * label can't answer.
 *
 * All terms must match, in any order and anywhere — so "acme backend" finds
 * "Tailored for Acme, Senior Backend Engineer" without anyone having to remember
 * the phrasing.
 */
export function matchesVersionSearch(
  version: Pick<ResumeVersion, 'label' | 'source'>,
  query: string,
): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${version.label}\n${version.source}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * The label for an added entry: the model's summary, or one built from the form.
 *
 * The fallback reproduces the shape the model is asked for ("Added Backend
 * Engineer, Globex") from the two fields that carry it, so the two sources of a
 * label are hard to tell apart in the list.
 */
export function resolveAddLabel(
  summary: string,
  draft: Pick<ResumeEntryDraft, 'title' | 'subtitle'>,
): string {
  const given = summary.trim();
  if (given) return truncateLabel(given);
  const title = draft.title.trim();
  const subtitle = draft.subtitle.trim();
  if (!title) return 'Added an entry';
  return truncateLabel(subtitle ? `Added ${title}, ${subtitle}` : `Added ${title}`);
}

/**
 * The label for an edited entry.
 *
 * Falls back to what the person asked for rather than which entry they asked
 * about: "add a bullet about the Postgres migration" already reads as a
 * description of a change, where the target ("the Globex role") only says where
 * the change landed.
 */
export function resolveEditLabel(
  summary: string,
  draft: Pick<ResumeEditDraft, 'instructions'>,
): string {
  const given = summary.trim();
  if (given) return truncateLabel(given);
  const asked = draft.instructions.trim();
  return asked ? truncateLabel(asked) : 'Edited an entry';
}

/**
 * Newest first, with `id` breaking ties.
 *
 * Applied even though the database already returns this order, because sync
 * doesn't promise one: rows pulled from another device arrive in whatever order
 * the server hands them over, and a list that reorders itself after a sync is a
 * list you can't trust. `id` as the tiebreak keeps two snapshots written in the
 * same millisecond — which one action can do — from swapping places between
 * reads.
 */
export function sortVersionsNewestFirst(versions: ResumeVersion[]): ResumeVersion[] {
  return [...versions].sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

/**
 * Which snapshot is "the original" — the oldest one.
 *
 * By position rather than by a stored flag: the oldest row *is* the original, and
 * a flag would be a second source of truth that sync could disagree with.
 */
export function isOriginal(version: ResumeVersion, versions: ResumeVersion[]): boolean {
  if (versions.length === 0) return false;
  const oldest = sortVersionsNewestFirst(versions)[versions.length - 1];
  return oldest.id === version.id;
}

/**
 * "2 min ago", "yesterday" — the age of a snapshot, for its list row.
 *
 * Coarse on purpose. What matters when picking a version is roughly how far back
 * it was and how it sits relative to its neighbours; a timestamp to the second
 * would be more precise and less readable.
 */
export function describeAge(createdAt: number, now = Date.now()): string {
  const seconds = Math.floor((now - createdAt) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}
