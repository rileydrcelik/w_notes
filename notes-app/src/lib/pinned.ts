/**
 * A star is a pin.
 *
 * Every feed in the app is ordered most-recently-touched first, which is the
 * right default and exactly wrong for the handful of things you keep coming
 * back to: the note you star is, by definition, one you don't edit every day, so
 * starring it used to push it *nowhere* while everything noisier drifted above
 * it. Starred items are therefore lifted to the front of whatever list they're
 * in, and the star icon already on the card doubles as the pin marker.
 *
 * The sort is stable, so within each band — pinned and not — the feed's own
 * ordering survives untouched. This is presentation only: nothing is written to
 * the row, so unstarring drops an item straight back into recency order with no
 * migration and no stored position to keep in sync across devices.
 */
export function pinnedFirst<T extends { favorite?: boolean }>(items: T[]): T[] {
  return [...items].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite));
}
