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

const BASE_URL = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '') ?? '';

export const syncConfigured = !!BASE_URL;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ApiError';
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
      Sentry.captureException(e, { tags: { source: 'sync-api', path } });
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
