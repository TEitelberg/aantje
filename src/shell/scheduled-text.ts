import type { ExpirableSplit, StorageInfo } from '../catalog/model';
import { formatUtc } from '../snapshot';
import { files, groupedPlural } from './numbers';

type Scheduled = StorageInfo['scheduledForDeletion'];

const ageOf = ({ age }: NonNullable<Scheduled['split']>): string =>
  age.source === 'option'
    ? `${age.text} (the option delete_older_than of the lake)`
    : `${age.text} (the default, the lake sets no delete_older_than)`;

/** `5 files scheduled: 3 ready to delete now, 2 waiting until 2026-11-03 10:00:00 UTC`; the count alone when the age is not known. */
export function scheduledLine(scheduled: Scheduled): string {
  const { count, split } = scheduled;
  const head = `${files(count)} scheduled`;
  if (count === 0 || split === null) return head;
  const parts = [
    ...(split.ready > 0
      ? [
          split.ready === count
            ? 'all ready to delete now'
            : `${groupedPlural(split.ready, 'file')} ready to delete now`,
        ]
      : []),
    ...(split.waiting > 0
      ? [
          split.nextReadyAt === null
            ? `${groupedPlural(split.waiting, 'file')} waiting`
            : `${split.waiting === count ? 'all' : groupedPlural(split.waiting, 'file')} waiting until ${formatUtc(split.nextReadyAt)}`,
        ]
      : []),
  ];
  return `${head}: ${parts.join(', ')}`;
}

/** What a clean-up can do now when no file is old enough; empty otherwise or when the age is not known. */
export function scheduledNote(scheduled: Scheduled): string {
  const { count, split } = scheduled;
  if (count === 0 || split === null || split.ready > 0) return '';
  return `Nothing is old enough: a file must be scheduled ${ageOf(split)} ago, so Clean Up Old Files as generated deletes none of them yet. Use cleanup_all => true, or an older_than that is later, to delete them now.`;
}

const expireAgeOf = ({ age }: ExpirableSplit): string =>
  age.source === 'option'
    ? `${age.text} (the option expire_older_than of the lake)`
    : `${age.text} (the default of aantje; the lake sets no expire_older_than)`;

/** `3 snapshots expirable now, 2 younger than 30 days (the default of aantje; ...)`; empty when the age is not known. */
export function expirableLine(expirable: ExpirableSplit | null): string {
  if (expirable === null) return '';
  const { ready, waiting } = expirable;
  return `${groupedPlural(ready, 'snapshot')} expirable now, ${waiting} younger than ${expireAgeOf(expirable)}`;
}

/** The warning that a call without an age expires nothing; empty when the lake sets the option or the age is not known. */
export function expirableNote(expirable: ExpirableSplit | null): string {
  if (expirable === null || expirable.age.source === 'option') return '';
  return `Expire Snapshots as generated names an age of ${expirable.age.text}, because a call without older_than expires nothing when the lake sets no expire_older_than.`;
}
