/**
 * The resume plugin's accent — which is now simply the app's accent.
 *
 * This module used to hold its own orange (`#c2703c`) and a darkened fill for
 * it. That made the resume screen the one place with a private accent: the
 * navbar above it marked the current tab in the app's colour and every control
 * below answered in a different one, so a screen largely made of borrowed navbar
 * furniture read as two designs stacked.
 *
 * The pair survives as re-exports, under the same names, because the distinction
 * they encode is the part worth keeping: `ACCENT` goes **on** a surface,
 * `ACCENT_FILL` goes **under white text**. Importing "the accent" and using it
 * as a button fill is how this plugin once shipped a label at 3.7:1, and two
 * names make that harder to do than one value and a comment would.
 *
 * See `constants/theme.ts` for the measured contrast behind each.
 */
export { Accent as ACCENT, AccentFill as ACCENT_FILL } from '@/constants/theme';
