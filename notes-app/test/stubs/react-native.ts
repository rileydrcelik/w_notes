/**
 * The slice of `react-native` that pure `src/lib` modules touch at import time.
 *
 * `grid.ts` reads `Platform.OS` while its module body evaluates, and the theme
 * it pulls in calls `Platform.select`. Both must resolve before the import
 * finishes, so there's no opportunity to configure them afterwards — tests that
 * need a different platform re-import the module under `vi.doMock` built from
 * `platformFor`; see grid.test.ts.
 *
 * Keep this minimal: it exists to make pure logic reachable, not to emulate
 * React Native.
 */
type OS = 'ios' | 'android' | 'web';

/** A `Platform` for the given OS, matching React Native's `select` precedence. */
export function platformFor(os: OS) {
  return {
    OS: os,
    select<T>(specifics: Record<string, T>): T | undefined {
      if (os in specifics) return specifics[os];
      // 'native' covers ios+android but never web — matching RN's own rule.
      if (os !== 'web' && 'native' in specifics) return specifics.native;
      return specifics.default;
    },
  };
}

/** Default for modules imported without an explicit mock: the phone layout. */
export const Platform = platformFor('ios');

/** Only referenced from hooks, which these tests don't call. */
export function useWindowDimensions() {
  throw new Error(
    'useWindowDimensions is a React hook — it needs a renderer, which these ' +
      'unit tests deliberately do not have. Test the pure function instead.',
  );
}

export type ViewStyle = Record<string, unknown>;
