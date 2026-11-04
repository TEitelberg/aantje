import { isCount, isNullOr, isOneOf, isShape, isString } from '../guards';
import type { ScheduledSplit } from './model';

/** Guard for a split by age as a page receives it. */
export const isSplit = isShape({
  age: isShape({ text: isString, source: isOneOf('option', 'default') }),
  ready: isCount,
  waiting: isCount,
  nextReadyAt: isNullOr(isString),
});

/** Guard for the scheduled files as a page receives them. */
export const isScheduled = isShape({
  count: isCount,
  oldestScheduledAt: isNullOr(isString),
  split: isNullOr(isSplit),
});

/** The age DuckLake 1.1 gives a file before `ducklake_cleanup_old_files` deletes it when the lake sets no `delete_older_than`. */
export const DEFAULT_DELETE_OLDER_THAN = '2 days';

const UNIT_MS = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
} as const;

const PART = /(\d{1,6}) (second|minute|hour|day|week)s?/y;

/** An interval of whole seconds up to weeks (`1 week`, `1 day 12 hours`) in milliseconds; months and years are not fixed lengths, so they and any other text give undefined. */
export function intervalMs(text: string): number | undefined {
  let total = 0;
  let at = 0;
  const value = text.trim();
  while (at < value.length) {
    if (at > 0) {
      if (value[at] !== ' ') return undefined;
      at++;
    }
    PART.lastIndex = at;
    const match = PART.exec(value);
    if (!match) return undefined;
    total += Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
    at = PART.lastIndex;
  }
  return value === '' ? undefined : total;
}

/** A group of files that were scheduled at the same moment. */
export interface ScheduledGroup {
  /** ISO 8601 UTC; null when the catalog has no readable time. */
  readonly scheduledAt: string | null;
  readonly files: number;
}

/** Groups of things with a time, divided by whether they are at least `option` (or else `fallback`) old at `now`. Undefined when the age is not a fixed length. */
export function splitByAge(
  groups: readonly ScheduledGroup[],
  option: string | undefined,
  fallback: string,
  now: Date,
): ScheduledSplit | undefined {
  const text = option ?? fallback;
  const ms = intervalMs(text);
  if (ms === undefined) return undefined;
  const cutoff = now.getTime() - ms;
  let ready = 0;
  let waiting = 0;
  let next = Infinity;
  for (const { scheduledAt, files } of groups) {
    const time = scheduledAt === null ? NaN : Date.parse(scheduledAt);
    if (time <= cutoff) {
      ready += files;
    } else {
      waiting += files;
      next = Math.min(next, time + ms);
    }
  }
  return {
    age: { text: text.trim(), source: option === undefined ? 'default' : 'option' },
    ready,
    waiting,
    nextReadyAt: Number.isFinite(next) ? new Date(next).toISOString() : null,
  };
}

/** Which of the scheduled files `ducklake_cleanup_old_files` deletes now: those scheduled at least the age ago. Undefined when the age is not a fixed length. */
export const splitScheduled = (
  groups: readonly ScheduledGroup[],
  option: string | undefined,
  now: Date,
): ScheduledSplit | undefined => splitByAge(groups, option, DEFAULT_DELETE_OLDER_THAN, now);
