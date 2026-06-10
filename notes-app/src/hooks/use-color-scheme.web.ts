import { useThemePref } from '@/store/theme-store';

/** Resolved light/dark scheme, reflecting the user's theme choice. */
export function useColorScheme() {
  return useThemePref().scheme;
}
