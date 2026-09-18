import type { InternshipStatus } from '@/lib/internship';

/** The tracker's own accent — its briefcase, the Applied chip. Darker than a
 *  pure amber on purpose: it labels small chip text, which wants 4.5:1 against
 *  the light background (the reason `AccentFill` exists beside `Accent`). */
export const INTERNSHIP_ACCENT = '#9a5b16';

/**
 * One colour per status, so a group, its stat and its row chips read as the
 * same thing at a glance. Green for the win, red for the no, the tracker's amber
 * for waiting on them, and two quieter hues between.
 */
export const STATUS_COLOR: Record<InternshipStatus, string> = {
  offer: '#2f9e6e',
  proc: '#8250df',
  oa: '#3c87f7',
  applied: INTERNSHIP_ACCENT,
  rejected: '#e5484d',
};
