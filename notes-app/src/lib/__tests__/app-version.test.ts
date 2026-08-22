import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The version label Settings shows at the bottom of the screen.
 *
 * `app-version.ts` reads the Expo config once, at import time, so each case
 * resets the module registry and re-imports with a different mocked config
 * rather than trying to mutate a value that was already captured.
 */
const config = { expoConfig: null as Record<string, unknown> | null };

vi.mock('expo-constants', () => ({
  get default() {
    return config;
  },
}));

async function labelFor(expoConfig: Record<string, unknown> | null) {
  config.expoConfig = expoConfig;
  vi.resetModules();
  const { appVersionLabel } = await import('../app-version');
  return appVersionLabel();
}

describe('appVersionLabel', () => {
  beforeEach(() => {
    config.expoConfig = null;
  });

  it('names the version from the Expo config', async () => {
    expect(await labelFor({ version: '1.2.3' })).toBe('Version 1.2.3');
  });

  it('appends the iOS build number when the config carries one', async () => {
    expect(await labelFor({ version: '1.2.3', ios: { buildNumber: '15' } })).toBe(
      'Version 1.2.3 (15)',
    );
  });

  // EAS keeps versionCode as a number; the label has to survive that without
  // rendering "[object Object]" or dropping the build entirely.
  it('appends a numeric Android versionCode', async () => {
    expect(await labelFor({ version: '1.2.3', android: { versionCode: 15 } })).toBe(
      'Version 1.2.3 (15)',
    );
  });

  // The production profile sets appVersionSource: "remote", so EAS owns the
  // build number and it is absent from the config here — the common case.
  it('falls back to the bare version when no build number exists', async () => {
    expect(await labelFor({ version: '1.2.3' })).toBe('Version 1.2.3');
  });

  // Better to render nothing than "Version " with a blank after it.
  it('returns null when there is no version at all', async () => {
    expect(await labelFor(null)).toBeNull();
    expect(await labelFor({})).toBeNull();
  });
});
