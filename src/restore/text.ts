import type { SnapshotId } from '../catalog/model';
import { formatUtc } from '../snapshot';

// Texts that both restore scripts write. They hold numbers and fixed words only, never catalog text.

export const NOTHING_RUN = 'Nothing has run: read the statements and run them in a read/write SQL session.';

/** `snapshot 42 (2026-11-10 08:12:00 UTC)`; without the time when it is unknown. */
export const snapshotText = (id: SnapshotId, time: string | null): string =>
  time === null ? `snapshot ${id}` : `snapshot ${id} (${formatUtc(time)})`;

export const deleteWarning = (snapshot: SnapshotId): string =>
  `-- Warning: this deletes every row of the table; the INSERT below writes the rows of snapshot ${snapshot}.`;

export const NEW_ID = '-- It comes back with a new id: its History before the drop is not joined to it.';
