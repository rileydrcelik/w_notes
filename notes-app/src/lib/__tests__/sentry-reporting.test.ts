import { describe, expect, it } from 'vitest';

import { shouldSendEvents } from '../sentry-reporting';

/**
 * The rule that decides whether crashes leave the device.
 *
 * Both directions matter and they fail differently. Getting dev wrong puts
 * laptop noise in the project the Sentry note reads and the autofix pipeline
 * acts on; getting production wrong blinds the live app, and nothing would
 * announce it — there is no alert for "no alerts".
 */
describe('shouldSendEvents', () => {
  it('stays quiet in dev by default', () => {
    expect(shouldSendEvents({ isDev: true })).toBe(false);
    expect(shouldSendEvents({ isDev: true, devOptIn: undefined })).toBe(false);
    expect(shouldSendEvents({ isDev: true, devOptIn: null })).toBe(false);
    expect(shouldSendEvents({ isDev: true, devOptIn: '' })).toBe(false);
  });

  it('reports from dev when explicitly opted in', () => {
    for (const flag of ['1', 'true', 'yes', 'TRUE', ' 1 ']) {
      expect(shouldSendEvents({ isDev: true, devOptIn: flag })).toBe(true);
    }
  });

  // "0"/"false" read as off to a human, so they must not read as on here.
  it('treats negative-looking flags as off', () => {
    for (const flag of ['0', 'false', 'no', 'off']) {
      expect(shouldSendEvents({ isDev: true, devOptIn: flag })).toBe(false);
    }
  });

  // The load-bearing case. A stray EXPO_PUBLIC_SENTRY_DEV=0 in someone's .env
  // must never be able to switch off reporting for the shipped app.
  it('always reports in production, whatever the flag says', () => {
    for (const flag of [undefined, null, '', '0', 'false', '1', 'nonsense']) {
      expect(shouldSendEvents({ isDev: false, devOptIn: flag })).toBe(true);
    }
  });
});
