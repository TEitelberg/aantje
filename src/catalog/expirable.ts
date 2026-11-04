import { isNullOr } from '../guards';
import { isSplit, splitByAge } from './scheduled';
import type { ScheduledGroup } from './scheduled';
import type { ExpirableSplit } from './model';

/** The age aantje uses for Expire Snapshots when the lake sets no `expire_older_than`. DuckLake has no default: without the option and without `older_than` the call expires nothing. */
export const DEFAULT_EXPIRE_OLDER_THAN = '30 days';

/** Undefined when the age is not a fixed length. `times` are the snapshots without the newest, as ISO 8601 UTC (null: unreadable, counted as waiting). */
export function splitExpirable(
  times: readonly (string | null)[],
  option: string | undefined,
  now: Date,
): ExpirableSplit | undefined {
  const groups: ScheduledGroup[] = times.map((scheduledAt) => ({ scheduledAt, files: 1 }));
  return splitByAge(groups, option, DEFAULT_EXPIRE_OLDER_THAN, now);
}

/** Guard for the expirable snapshots as a page receives them. */
export const isExpirable = isNullOr(isSplit);
