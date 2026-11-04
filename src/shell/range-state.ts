import { isCount, isShape } from '../guards';

// The snapshot range that the pages of the history reports keep for a hidden panel or a refresh.

/** First and last snapshot a page showed: the range ends while the user has not moved them. */
export interface Bounds {
  readonly first: number;
  readonly last: number;
}

export const isBounds = isShape({ first: isCount, last: isCount });

export function boundsOf(snapshots: readonly { readonly id: number }[]): Bounds {
  return { first: snapshots[0]?.id ?? 0, last: snapshots.at(-1)?.id ?? 0 };
}

/** An end at the old last snapshot follows the new one; other ends are clamped. */
export function restoredRange(
  range: { readonly from: number; readonly to: number },
  was: Bounds,
  now: Bounds,
): { readonly from: number; readonly to: number } {
  const fit = (value: number): number => Math.min(Math.max(value, now.first), now.last);
  return {
    from: range.from === was.first ? now.first : fit(range.from),
    to: range.to === was.last ? now.last : fit(range.to),
  };
}
