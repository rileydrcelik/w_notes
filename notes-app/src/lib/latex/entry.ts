/**
 * Asking the backend to draft one resume entry.
 *
 * The Anthropic call happens on the server (`POST /resume/entry`) for the reason
 * every credential does: an API key shipped in the app bundle is an API key
 * anyone can read out of it. The client sends the resume and the filled-in form
 * and gets back a LaTeX fragment; splicing it into the document is
 * `lib/latex/sections.ts`'s job, and showing it to the user before that happens
 * is the screen's.
 */
import type { LatexEngine } from '@/lib/latex/types';
import { apiFetch, syncConfigured } from '@/lib/sync/api';

/** What the adder's form collects. Everything but the title is optional. */
export type ResumeEntryDraft = {
  /** The section it goes in — an existing one, or a new name. */
  section: string;
  /** Whether that section already exists in the document. */
  sectionExists: boolean;
  title: string;
  subtitle: string;
  location: string;
  /**
   * Free text, not dates. "2024", "Summer 2024" and "Present" are all things
   * people put on resumes, and a date type would reject every one of them —
   * which is what "incomplete values are fine" has to mean in practice.
   */
  dateFrom: string;
  dateTo: string;
  link: string;
  description: string;
  /**
   * Pages for the model to read before writing — a repo, a project page, a
   * post. Held as raw text, one URL per line, because that's what the field on
   * screen is; splitting it into a list is this module's job at the request
   * boundary, and the server validates the result again rather than trusting it
   * (see `_clean_links` in `backend/app/routers/resume.py`).
   *
   * The pages are fetched by Anthropic's web_fetch tool, not by the backend and
   * not by the app — nothing here ever makes a request to a URL a user typed.
   */
  contextLinks: string;
};

/**
 * How long to wait for a drafted entry before giving up.
 *
 * Above the server's own ceiling on purpose — it allows itself roughly two
 * minutes when every context link is used (see `anthropic_timeout_seconds` and
 * the per-link allowance in `backend/app/routers/resume.py`), and when it gives
 * up it says something far more useful than "the client stopped waiting". This
 * is only for the case where no answer is coming at all.
 *
 * Measured, not guessed: no links is ~6s, one link ~38s, two ~45s — reading the
 * pages is most of the first link's cost and each one after is cheap.
 *
 * The same gap existed in `engine.ts` and had the same consequence there: a
 * request with no deadline leaves a spinner running with nothing on the way.
 */
const DRAFT_TIMEOUT_MS = 140_000;

/** Split the field's text into the URLs to send. */
export function parseContextLinks(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** An empty draft, for opening the form. */
export function emptyEntryDraft(section = ''): ResumeEntryDraft {
  return {
    section,
    sectionExists: section.length > 0,
    title: '',
    subtitle: '',
    location: '',
    dateFrom: '',
    dateTo: '',
    link: '',
    description: '',
    contextLinks: '',
  };
}

/** The backend's response shape. */
type EntryApiResponse = {
  section: string;
  latex: string;
  /** Optional: an older server predates version labels and sends nothing. */
  summary?: string;
};

/** What came back: the section to file it under, and the LaTeX to insert. */
export type DraftedEntry = {
  section: string;
  latex: string;
  /**
   * A one-line description of the change, for the version history's label.
   *
   * It rides along in the same structured response as the entry itself, so it
   * costs no second round trip — the model is already holding everything needed
   * to name what it just wrote. Empty when the server didn't supply one, and the
   * caller falls back to a label derived from the form (see
   * `lib/resume/versions.ts`); a missing caption must never cost someone the
   * entry it was captioning.
   */
  summary: string;
};

export type DraftResult =
  | { ok: true; entry: DraftedEntry }
  | { ok: false; message: string };

/** Whether drafting is possible at all — i.e. an API is configured. */
export function isEntryDraftSupported(): boolean {
  return syncConfigured;
}

/**
 * Ask the server for the entry. Never throws: a failure is a message to put on
 * screen, because every way this can fail is one the person can act on (try
 * again, shorten the description, check they're online).
 */
export async function draftResumeEntry(
  source: string,
  draft: ResumeEntryDraft,
): Promise<DraftResult> {
  if (!syncConfigured) {
    return {
      ok: false,
      message: 'This app is not connected to a server, so it cannot write entries.',
    };
  }

  // Cleared in `finally`, so a draft that answers normally doesn't leave a
  // two-minute timer alive behind it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS);

  try {
    const response = await apiFetch<EntryApiResponse>('/resume/entry', {
      method: 'POST',
      signal: controller.signal,
      body: {
        source,
        section: draft.section,
        section_exists: draft.sectionExists,
        title: draft.title,
        subtitle: draft.subtitle,
        location: draft.location,
        date_from: draft.dateFrom,
        date_to: draft.dateTo,
        link: draft.link,
        description: draft.description,
        context_links: parseContextLinks(draft.contextLinks),
      },
    });

    if (!response?.latex?.trim()) {
      return { ok: false, message: 'The server came back with an empty entry. Try again.' };
    }
    return {
      ok: true,
      entry: {
        section: response.section || draft.section,
        latex: response.latex,
        summary: response.summary?.trim() ?? '',
      },
    };
  } catch (e) {
    // Our own deadline, not the server's fault and not the network's. Checked
    // off the controller rather than the error, because what a cancelled
    // request throws differs between fetch implementations.
    if (controller.signal.aborted) {
      return {
        ok: false,
        message: `The server didn't answer within ${Math.round(
          DRAFT_TIMEOUT_MS / 1000,
        )} seconds. Try again, or with fewer context links.`,
      };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message: describeFailure(message) };
  } finally {
    clearTimeout(timer);
  }
}

/** What the edit form collects. */
export type ResumeEditDraft = {
  /**
   * Which part of the resume to change, in the person's own words — one bullet,
   * one entry, a section, or the whole document. The server decides from this
   * whether the change is a quotable span or a whole-document rewrite; it is not
   * a choice the form makes them declare.
   */
  target: string;
  /** How they want it changed. */
  instructions: string;
};

/** An empty edit draft, for opening the form. */
export function emptyEditDraft(): ResumeEditDraft {
  return { target: '', instructions: '' };
}

type EditApiResponse = {
  scope?: 'span' | 'document';
  old_latex: string;
  new_latex: string;
  /** Optional: an older server predates version labels and sends nothing. */
  summary?: string;
};

/**
 * A verified replacement: this exact run of the document becomes that one.
 *
 * Both halves travel back because both are needed — `newLatex` is what the
 * person reviews, and `oldLatex` is what makes applying it checkable rather
 * than a matter of trust (see `replaceResumeEntry` in `sections.ts`).
 */
export type DraftedEdit = {
  /**
   * How wide the change reaches, and therefore how it gets applied.
   *
   * `span` is the narrow case and much the commoner one: the server quoted an
   * exact run of the document and verified it appears there exactly once, so
   * applying it is a literal single-occurrence replace and everything outside
   * the quote is untouched by construction.
   *
   * `document` is for a change no single quote could express — "rewrite the whole
   * thing", or one that reaches several separated places. There is no quote to
   * verify, so the server compiles the result instead and the whole source is
   * replaced. `oldLatex` is empty.
   */
  scope: 'span' | 'document';
  oldLatex: string;
  newLatex: string;
  /** See `DraftedEntry.summary` — the version label for this change. */
  summary: string;
};

export type EditResult =
  | { ok: true; edit: DraftedEdit }
  | { ok: false; message: string };

/**
 * Ask the server to rewrite one entry. Never throws, for the same reason
 * `draftResumeEntry` doesn't: every failure here is one the person can act on.
 */
export async function requestEntryEdit(
  source: string,
  draft: ResumeEditDraft,
  /** The resume's engine, so a whole-document rewrite is verified with the right one. */
  engine: LatexEngine = 'pdflatex',
): Promise<EditResult> {
  if (!syncConfigured) {
    return {
      ok: false,
      message: 'This app is not connected to a server, so it cannot edit entries.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS);

  try {
    const response = await apiFetch<EditApiResponse>('/resume/edit', {
      method: 'POST',
      signal: controller.signal,
      body: {
        source,
        target: draft.target,
        instructions: draft.instructions,
        engine,
      },
    });

    if (!response?.new_latex?.trim()) {
      return { ok: false, message: 'The server came back with an empty edit. Try again.' };
    }
    // A span edit is only applicable with its quote; a document rewrite has none
    // by design, and replaces the source outright.
    if (response.scope !== 'document' && !response.old_latex) {
      return { ok: false, message: 'The server came back with an empty edit. Try again.' };
    }
    return {
      ok: true,
      edit: {
        // Defaulted, so a server that predates whole-document edits reads as the
        // narrow case it only ever produced.
        scope: response.scope === 'document' ? 'document' : 'span',
        oldLatex: response.old_latex,
        newLatex: response.new_latex,
        summary: response.summary?.trim() ?? '',
      },
    };
  } catch (e) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        message: `The server didn't answer within ${Math.round(
          DRAFT_TIMEOUT_MS / 1000,
        )} seconds. Try again.`,
      };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message: describeEditFailure(message) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Edit-specific failure text. 422 covers every way the *edit* itself didn't
 * work — entry not found, quote matched twice, change was a no-op — and the
 * server's own sentence says which, so it is worth passing through rather than
 * flattening to one generic line the way `describeFailure` does.
 */
function describeEditFailure(message: string): string {
  if (message.includes('429')) {
    return 'The server is writing as many entries as it can. Try again in a moment.';
  }
  if (message.includes('503')) {
    return 'This server is not set up to edit resume entries yet.';
  }
  if (message.includes('504')) {
    return 'Editing this entry took too long. Try again.';
  }
  if (message.includes('413')) {
    return 'This resume is too large to edit.';
  }
  if (message.includes('422')) {
    return 'Could not make that edit. Try describing the entry or the change differently.';
  }
  return `The entry could not be edited: ${message}`;
}

/** Turn an `ApiError`-ish message into something worth showing a person. */
function describeFailure(message: string): string {
  if (message.includes('429')) {
    return 'The server is writing as many entries as it can. Try again in a moment.';
  }
  if (message.includes('503')) {
    return 'This server is not set up to write resume entries yet.';
  }
  if (message.includes('504')) {
    return 'Writing this entry took too long. Try again.';
  }
  if (message.includes('413')) {
    return 'This resume is too large to add to.';
  }
  if (message.includes('422')) {
    return 'This entry could not be written. Try rewording the description.';
  }
  return `The entry could not be written: ${message}`;
}
