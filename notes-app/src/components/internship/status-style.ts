import { Accent, AccentFill } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import type { InternshipStatus } from '@/lib/internship';

/** The tracker's own accent — the briefcase on its card. Darker than a pure
 *  amber on purpose, so a small glyph still reads against the light background. */
export const INTERNSHIP_ACCENT = '#9a5b16';

/**
 * One colour per status, so a group, its stat and its row chips read as the
 * same thing at a glance: the app's accent for an offer, blue while in process,
 * orange for an OA, yellow for waiting on them, red for the no.
 *
 * These are the dark-theme values. They label small text (chips, counts), so
 * on the light background each needs 4.5:1, which bright yellow (1.6:1) and
 * orange (3:1) are nowhere near — the light set is the same hues, darkened
 * until they clear it. Read them through `useStatusColors`.
 */
export const STATUS_COLOR: Record<InternshipStatus, string> = {
  offer: Accent,
  proc: '#3c87f7',
  oa: '#f76b15',
  applied: '#f5c518',
  rejected: '#e5484d',
};

/** The light-theme set: each at least 4.5:1 on white. */
export const STATUS_COLOR_LIGHT: Record<InternshipStatus, string> = {
  offer: AccentFill,
  proc: '#1f6fe0',
  oa: '#b54708',
  applied: '#8a6a00',
  rejected: '#d13438',
};

/** Status colours for the active theme. */
export function useStatusColors(): Record<InternshipStatus, string> {
  return useColorScheme() === 'light' ? STATUS_COLOR_LIGHT : STATUS_COLOR;
}
