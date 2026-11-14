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

interface Range {
  readonly from: number;
  readonly to: number;
}

const clamp = (value: number, bounds: Bounds): number => Math.min(Math.max(value, bounds.first), bounds.last);

/** The range with both ends inside the bounds; without a range, all of them. */
export const fitRange = (range: Range | undefined, bounds: Bounds): Range =>
  range
    ? { from: clamp(range.from, bounds), to: clamp(range.to, bounds) }
    : { from: bounds.first, to: bounds.last };

/** An end at the old last snapshot follows the new one; other ends are clamped. */
export function restoredRange(range: Range, was: Bounds, now: Bounds): Range {
  return {
    from: range.from === was.first ? now.first : clamp(range.from, now),
    to: range.to === was.last ? now.last : clamp(range.to, now),
  };
}
