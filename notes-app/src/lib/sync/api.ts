/**
 * Thin fetch wrapper for the sync backend. Adds the base URL, the device-key
 * bearer token, and Sentry breadcrumbs/error capture around each request.
 *
 * Base URL comes from `EXPO_PUBLIC_API_URL` (e.g. http://192.168.1.x:8000). When
 * it's unset the client is considered offline-only and `apiFetch` throws a clear
 * error rather than hitting a bogus host.
 */
import { Sentry } from '@/lib/sentry';
import { AuthUnavailableError, getAuthToken } from '@/lib/auth/token';
import { apiErrorMessage, detailFromBody } from './api-detail';
import { fingerprintPath } from './fingerprint';

export { apiErrorMessage, fingerprintPath };

const BASE_URL = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '') ?? '';

export const syncConfigured = !!BASE_URL;

export class ApiError extends Error {
  /**
   * The backend's own explanation, pulled out of `{"detail": ...}`.
   *
   * Kept as a field rather than parsed at each call site so there is one answer
   * to "what did the server actually say", and so a screen can show it without
   * knowing FastAPI's error shape. Use `apiErrorMessage` to decide whether it is
   * worth showing — not every status carries advice.
   */
  readonly detail?: string;

  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.detail = detailFromBody(body);
  }
}

type ApiOptions = Omit<RequestInit, 'body'> & { body?: unknown };

/** Performs an authenticated JSON request against the sync backend. */
export async function apiFetch<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  if (!BASE_URL) {
    throw new Error('EXPO_PUBLIC_API_URL is not set — sync backend is not configured.');
  }

  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const { body, headers, ...rest } = options;

  Sentry.addBreadcrumb({
    category: 'sync',
    message: `${rest.method ?? 'GET'} ${path}`,
    level: 'info',
  });

  try {
    const token = await getAuthToken();
    const res = await fetch(url, {
      ...rest,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(`${res.status} ${res.statusText} for ${path}`, res.status, text);
    }

    // 204 / empty bodies decode to undefined.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } catch (e) {
    // Three outcomes reach here, and only one is worth reporting.
    if (e instanceof ApiError) {
      // The backend answered with a non-2xx. That's a real failure on our side.
      //
      // Fingerprint by endpoint + status, not by the default stack trace. Every
      // ApiError is constructed on the same line of this file, so Sentry's
      // default grouping folded *every* backend failure — a 401 on /sync/push, a
      // 504 on /sync/pull, a 502 from the Sentry proxy — into one issue. That
      // issue then reads as a single bug that keeps "coming back" while it's
      // really a queue of unrelated ones, and anything working from its latest
      // event (a person or an autofix run) is handed the wrong error.
      Sentry.captureException(e, {
        tags: { source: 'sync-api', path, status: String(e.status) },
        fingerprint: ['sync-api', String(e.status), fingerprintPath(path)],
      });
    } else if (e instanceof AuthUnavailableError) {
      // An account's Firebase session isn't available yet (restoring on launch,
      // or dropped). Sync defers and retries; nothing is wrong.
      Sentry.addBreadcrumb({
        category: 'sync',
        message: `sync deferred on ${path}: auth session unavailable`,
        level: 'info',
      });
    } else {
      // Network-level failures (offline, DNS, CORS) are transient and expected
      // in normal use — keep them as context rather than reporting each one.
      Sentry.addBreadcrumb({
        category: 'sync',
        message: `network error on ${path}: ${e instanceof Error ? e.message : String(e)}`,
        level: 'warning',
      });
    }
    throw e;
  }
}
