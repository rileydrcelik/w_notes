import { describe, expect, it } from 'vitest';

// app.config.js is plain JS outside src/; tsconfig has allowJs, so it infers.
import appConfig, { runtimeVersionFor } from '../../../app.config.js';

/**
 * The split between the two numbers that used to be one.
 *
 * `expo.version` is the display version and moves on every push. The runtime
 * version is an OTA compatibility boundary: an `eas update` only reaches
 * devices whose binary was built at the same one. While `runtimeVersion` used
 * the `appVersion` policy those were the same string, so every patch bump
 * started a lineage nobody was running and the update reached zero devices.
 *
 * These tests pin the property that fixes it — the patch digit does not reach
 * the runtime version, and the minor digit does.
 */
describe('runtimeVersionFor', () => {
  it('drops the patch digit', () => {
    expect(runtimeVersionFor('1.2.3')).toBe('1.2');
  });

  // The whole point: three patch releases, one lineage, so an OTA update
  // published from any of them lands on binaries built from the others.
  it('keeps patch releases on one lineage', () => {
    const lineages = ['1.2.0', '1.2.1', '1.2.9'].map(runtimeVersionFor);
    expect(new Set(lineages).size).toBe(1);
  });

  // And the converse: a minor bump is how you deliberately break that.
  it('starts a new lineage on a minor or major bump', () => {
    expect(runtimeVersionFor('1.3.0')).not.toBe(runtimeVersionFor('1.2.9'));
    expect(runtimeVersionFor('2.0.0')).not.toBe(runtimeVersionFor('1.9.9'));
  });

  // Two-digit minors must not be truncated or compared as numbers — 1.10 is a
  // later lineage than 1.9, and reading it as "1.1" would silently reuse one.
  it('handles multi-digit segments', () => {
    expect(runtimeVersionFor('1.10.0')).toBe('1.10');
    expect(runtimeVersionFor('10.20.30')).toBe('10.20');
  });

  // A version it can't parse would pick some other lineage and orphan every
  // install from OTA updates, so it fails at config-eval time instead.
  it.each([['1.2'], ['1'], ['v1.2.3'], ['1.2.3-beta'], [''], [null], [undefined]])(
    'rejects %p rather than guessing a lineage',
    (version) => {
      expect(() => runtimeVersionFor(version)).toThrow(/major\.minor\.patch/);
    },
  );
});

describe('the resolved Expo config', () => {
  // The derivation is only worth anything if the config actually uses it — the
  // `appVersion` policy would silently win back if it were reintroduced.
  it('derives runtimeVersion from the display version', () => {
    const resolved = appConfig({ config: { version: '4.5.6', ios: {}, android: {}, web: {} } });
    expect(resolved.version).toBe('4.5.6');
    expect(resolved.runtimeVersion).toBe('4.5');
  });

  it('refuses to resolve a config whose version cannot be parsed', () => {
    expect(() =>
      appConfig({ config: { version: '4.5', ios: {}, android: {}, web: {} } }),
    ).toThrow(/major\.minor\.patch/);
  });
});
