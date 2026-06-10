import { useThemePref } from '@/store/theme-store';

/** The active color palette, reflecting the user's theme choice. */
export function useTheme() {
  return useThemePref().colors;
}
