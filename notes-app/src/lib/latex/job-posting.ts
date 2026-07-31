/**
 * Reading a job posting off a link, so the tailor's form is one paste instead of
 * four fields.
 *
 * **Most job postings cannot be read**, and that is the fact this module is built
 * around rather than one it hides. Measured against the real fetch: a static
 * Greenhouse board or a company careers page reads fine; Ashby returns a bare
 * "you need to enable JavaScript" shell; Lever answers `url_not_accessible`;
 * LinkedIn and Workday are refused outright. Those are the sites people actually
 * apply through, so the unreadable case is not an edge — it is the common one,
 * and it has to land somewhere useful.
 *
 * So this is a *separate, short* call rather than a branch inside tailoring. A
 * link that can't be read costs about fifteen seconds and reveals the paste
 * fields; folded into the tailor it would have burned a whole document
 * generation and a TeX run first, to arrive at the same place two minutes later.
 *
 * The page is fetched by Anthropic's `web_fetch` tool, not by the backend and not
 * by the app — nothing on our side of the wire ever requests a URL a user typed.
 */
import { ApiError, apiFetch, syncConfigured } from '@/lib/sync/api';

/** What a posting gave up, ready to drop into the tailor's draft. */
export type JobPosting = {
  company: string;
  role: string;
  /** The posting's own text — responsibilities and, above all, requirements. */
  description: string;
};

export type PostingResult =
  | { ok: true; posting: JobPosting }
  /**
   * `unreadable` is the case the sheet acts on rather than just reports: it means
   * the link was fine but the page can't be fetched, so the answer is to show the
   * paste fields. Any other failure is a message and nothing more.
   */
  | { ok: false; unreadable: boolean; message: string };

/**
 * How long to wait for a posting to be read.
 *
 * One fetch and a short extraction — far quicker than tailoring, and deliberately
 * bounded well under it, because this runs *before* the long part and a person is
 * watching a link they just pasted.
 */
const POSTING_TIMEOUT_MS = 90_000;

/** True once a string looks like a link worth sending. */
export function looksLikeUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  // Needs a host with a dot in it: "https://foo" is not a posting.
  const host = trimmed.slice(trimmed.indexOf('://') + 3).split(/[/?#]/)[0];
  return host.includes('.') && host.length > 3;
}

export async function readJobPosting(url: string): Promise<PostingResult> {
  if (!syncConfigured) {
    return {
      ok: false,
      unreadable: false,
      message: 'This app is not connected to a server, so it cannot read job postings.',
    };
  }
  if (!looksLikeUrl(url)) {
    return {
      ok: false,
      unreadable: false,
      message: 'That doesn’t look like a link. It should start with http:// or https://.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POSTING_TIMEOUT_MS);

  try {
    const response = await apiFetch<JobPosting>('/resume/job-posting', {
      method: 'POST',
      signal: controller.signal,
      body: { url: url.trim() },
    });
    if (!response?.description?.trim()) {
      return { ok: false, unreadable: true, message: UNREADABLE };
    }
    return {
      ok: true,
      posting: {
        company: response.company?.trim() ?? '',
        role: response.role?.trim() ?? '',
        description: response.description.trim(),
      },
    };
  } catch (e) {
    if (controller.signal.aborted) {
      // A page that takes this long is one we're not going to get. Treated as
      // unreadable rather than as an error, because the useful next step is the
      // same either way: paste it.
      return { ok: false, unreadable: true, message: UNREADABLE };
    }
    // 422 is the server saying it read the page and there was no posting on it.
    // That is the case worth acting on, so it carries the server's own sentence.
    if (e instanceof ApiError && e.status === 422) {
      return { ok: false, unreadable: true, message: detailOf(e) ?? UNREADABLE };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, unreadable: false, message: describeFailure(message) };
  } finally {
    clearTimeout(timer);
  }
}

const UNREADABLE =
  'That page couldn’t be read. Many job sites — LinkedIn and Workday among them — block automated readers. Paste the posting instead.';

function detailOf(e: ApiError): string | null {
  if (!e.body) return null;
  try {
    const parsed = JSON.parse(e.body) as { detail?: unknown };
    return typeof parsed.detail === 'string' && parsed.detail.trim() ? parsed.detail : null;
  } catch {
    return null;
  }
}

function describeFailure(message: string): string {
  if (message.includes('429')) {
    return 'The server is reading as much as it can right now. Try again in a moment.';
  }
  if (message.includes('503')) {
    return 'This server is not set up to read job postings yet.';
  }
  if (message.includes('400')) {
    return 'That doesn’t look like a link. It should start with http:// or https://.';
  }
  return `That link could not be read: ${message}`;
}
