import { openingSignature } from './connections/profile';
import type { ConnectionProfile } from './connections/profile';

// What opens a catalog, by connection id: a rename leaves it unchanged, an edited path or host changes it.
type OpeningSignatures = ReadonlyMap<string, string>;

export function signaturesOf(profiles: readonly ConnectionProfile[]): Map<string, string> {
  return new Map(profiles.map((profile) => [profile.id, openingSignature(profile)]));
}

/** The ids of existing connections whose opening signature changed. */
export function reopenedIds(before: OpeningSignatures, profiles: readonly ConnectionProfile[]): Set<string> {
  return new Set(
    profiles
      .filter((profile) => {
        const known = before.get(profile.id);
        return known !== undefined && known !== openingSignature(profile);
      })
      .map((profile) => profile.id),
  );
}

/** The warning for skipped `aantje.connections` entries; undefined when none. */
export function invalidEntriesText(count: number): string | undefined {
  if (count === 0) {
    return undefined;
  }
  return count === 1
    ? 'An entry of "aantje.connections" is invalid and was skipped. See the "aantje" output channel.'
    : `${count} entries of "aantje.connections" are invalid and were skipped. See the "aantje" output channel.`;
}
