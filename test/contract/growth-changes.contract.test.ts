import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver } from '../../src/catalog/drivers/driver';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader, GrowthChange, SnapshotId } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID, HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import { LATEST_SNAPSHOT } from '../support/expected';
import { wasmPath } from '../support/fixtures';
import { catalogSources } from '../support/sources';
import { historyFixture, historySources } from '../support/sources/history';
import type { CatalogSource } from '../support/sources/types';

interface State {
  rows: number;
  sizeBytes: number;
  files: number;
  partial: number;
}

/** The state of every table after `snapshot`: the sum of the changes up to it (the summed-up ones have `snapshot: null`). */
function stateAt(changes: readonly GrowthChange[], snapshot: SnapshotId): Map<number, State> {
  const states = new Map<number, State>();
  for (const change of changes) {
    if (change.snapshot === null || change.snapshot <= snapshot) {
      const state = states.get(change.tableId) ?? { rows: 0, sizeBytes: 0, files: 0, partial: 0 };
      state.rows += change.rows;
      state.sizeBytes += change.sizeBytes;
      state.files += change.files;
      state.partial += change.partialFiles;
      states.set(change.tableId, state);
    }
  }
  return states;
}

/**
 * What the reader says about every table at a snapshot, one query per schema: the numbers of `tables`, which is what
 * the tree shows, plus the inlined rows that are valid then (counted with SQL on the raw catalog).
 */
async function brute(
  reader: CatalogReader,
  raw: Driver,
  inlinedTables: readonly { table_id: number; table_name: string }[],
  snapshot: SnapshotId,
): Promise<Map<number, State>> {
  const states = new Map<number, State>();
  for (const schema of await reader.schemas(snapshot)) {
    for (const table of await reader.tables(schema.id, snapshot)) {
      states.set(table.id, {
        rows: table.stats.rows,
        sizeBytes: table.stats.sizeBytes,
        files: table.stats.files,
        partial: table.stats.approximate ? 1 : 0,
      });
    }
  }
  for (const { table_id, table_name } of inlinedTables) {
    const [{ n }] = (await raw.query(
      `SELECT CAST(COUNT(*) AS BIGINT) AS n FROM "${table_name}"
       WHERE ${snapshot} >= _ducklake_begin_snapshot AND (${snapshot} < _ducklake_end_snapshot OR _ducklake_end_snapshot IS NULL)`,
    )) as [{ n: number }];
    const state = states.get(Number(table_id)) ?? { rows: 0, sizeBytes: 0, files: 0, partial: 0 };
    state.rows += Number(n);
    states.set(Number(table_id), state);
  }
  return states;
}

const visible = (states: Map<number, State>): (number | boolean)[][] =>
  [...states]
    .toSorted(([a], [b]) => a - b)
    .filter(([, state]) => state.rows !== 0 || state.sizeBytes !== 0 || state.files !== 0)
    .map(([id, state]) => [id, state.rows, state.sizeBytes, state.files, state.partial > 0]);

function describeSource(label: string, source: CatalogSource, latest: SnapshotId): void {
  const skipReason = source.skipReason();
  describe.skipIf(skipReason !== undefined)(
    `growth changes of ${label}, ${source.name}${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`,
    () => {
      let reader: CatalogReader;
      let raw: Driver;
      let inlinedTables: { table_id: number; table_name: string }[];

      beforeAll(async () => {
        reader = createCatalogReader(await source.open());
        raw = await source.open();
        inlinedTables = (await raw
          .query('SELECT table_id, table_name FROM ducklake_inlined_data_tables')
          .catch(() => [])) as { table_id: number; table_name: string }[];
      });
      afterAll(async () => {
        await reader.close();
        await raw.close();
      });

      it('adds up to the rows, bytes, files and partial marks the tree reads for every table at every snapshot, sums the snapshots before `first` into one entry per table, and has no no-op entries, ordered by table and snapshot', async () => {
        const first = Math.floor(latest / 2);
        const { changes: all, inlinedMore } = await reader.growthChanges(0);
        expect(inlinedMore).toBeUndefined();
        expect(all.some(({ snapshot }) => snapshot === null)).toBe(false);
        for (let snapshot = 0; snapshot <= latest; snapshot++) {
          expect(visible(stateAt(all, snapshot)), `snapshot ${snapshot}`).toEqual(
            visible(await brute(reader, raw, inlinedTables, snapshot)),
          );
        }

        const { changes } = await reader.growthChanges(first);
        expect(
          changes.filter(({ snapshot }) => snapshot !== null).every(({ snapshot }) => snapshot! >= first),
        ).toBe(true);
        const summed = changes.filter(({ snapshot }) => snapshot === null).map(({ tableId }) => tableId);
        expect(summed, 'one summed-up entry per table').toEqual([...new Set(summed)]);
        expect(visible(stateAt(changes, first - 1))).toEqual(visible(stateAt(all, first - 1)));
        for (let snapshot = first; snapshot <= latest; snapshot++) {
          expect(visible(stateAt(changes, snapshot)), `snapshot ${snapshot}`).toEqual(
            visible(stateAt(all, snapshot)),
          );
        }

        for (const list of [all, changes]) {
          expect(
            list.some((c) => c.rows === 0 && c.sizeBytes === 0 && c.files === 0 && c.partialFiles === 0),
          ).toBe(false);
          expect(list.map((c) => [c.tableId, c.snapshot ?? -1])).toEqual(
            list.map((c) => [c.tableId, c.snapshot ?? -1]).toSorted((a, b) => a[0]! - b[0]! || a[1]! - b[1]!),
          );
        }
      });
    },
  );
}

for (const source of catalogSources) {
  describeSource('the fixture', source, LATEST_SNAPSHOT);
}
for (const source of historySources) {
  describeSource('the history fixture', source, HISTORY_LATEST_SNAPSHOT);
}

describe('growth changes on the history fixture, sqlite', () => {
  it('counts the inlined rows of shop.notes by their begin and end snapshots, and marks the snapshots in which a file holds more than the snapshot', async () => {
    const reader = createCatalogReader(await (historySources[0] as CatalogSource).open());
    try {
      const { changes } = await reader.growthChanges(0);

      // 3 rows at 20, an update at 22 that ends the first version of row 1 and begins its second one, a delete that leaves 2.
      const notes = changes.filter(({ tableId }) => tableId === HISTORY_ID.notes);
      expect(notes.map(({ snapshot, rows, sizeBytes, files }) => [snapshot, rows, sizeBytes, files])).toEqual(
        [
          [20, 3, 0, 0],
          [22, -1, 0, 0],
        ],
      );

      // The delete file of the update at 17 and the compaction of shop.log at 51.
      expect(
        changes
          .filter(({ partialFiles }) => partialFiles !== 0)
          .map(({ tableId, snapshot, partialFiles }) => [tableId, snapshot, partialFiles]),
      ).toEqual([
        [HISTORY_ID.customers, 17, 1],
        [HISTORY_ID.customers, 18, -1],
        [HISTORY_ID.log, 51, 1],
        [HISTORY_ID.log, 54, -1],
      ]);
    } finally {
      await reader.close();
    }
  });
});

describe('growth changes on a catalog whose old snapshots expired', () => {
  it('has the state of the expired snapshots in the summed-up entries, so the first snapshot left shows the full state', async () => {
    const expired = createCatalogReader(await openSqlite({ path: historyFixture.expired, wasmPath }));
    try {
      expect((await expired.snapshots()).map(({ id }) => id).toSorted((a, b) => a - b)).toEqual([0, 55, 56]);
      const { changes } = await expired.growthChanges(55);

      expect(changes.some(({ snapshot }) => snapshot === null)).toBe(true);
      const at55 = stateAt(changes, 55);
      for (const schema of await expired.schemas(55)) {
        for (const table of await expired.tables(schema.id, 55)) {
          const state = at55.get(table.id);
          // The inlined rows of shop.notes are not in the figures of the tree.
          const inlined = table.id === HISTORY_ID.notes ? 2 : 0;
          expect([state?.rows ?? 0, state?.sizeBytes ?? 0, state?.files ?? 0], `table ${table.id}`).toEqual([
            table.stats.rows + inlined,
            table.stats.sizeBytes,
            table.stats.files,
          ]);
        }
      }
    } finally {
      await expired.close();
    }
  });
});

describe('growth changes on edited copies of the history fixture', () => {
  const edited = editedCatalogs();
  afterAll(() => edited.dispose());

  /** The state after `snapshot` of one table, summed up from the changes (as `stateAt`, for rows, bytes and files). */
  const totalOf = (changes: readonly GrowthChange[], table: number, snapshot: SnapshotId): number[] => {
    const state = stateAt(changes, snapshot).get(table);
    return [state?.rows ?? 0, state?.sizeBytes ?? 0, state?.files ?? 0];
  };

  /** rows, bytes and files of shop.customers as the tree shows them at `snapshot`. */
  const customersInTree = async (reader: CatalogReader, snapshot: SnapshotId): Promise<number[]> => {
    const [shop] = (await reader.schemas(snapshot)).filter(({ name }) => name === 'shop');
    const table = (await reader.tables(shop?.id ?? 0, snapshot)).find(
      ({ id }) => id === HISTORY_ID.customers,
    );
    return [table?.stats.rows ?? 0, table?.stats.sizeBytes ?? 0, table?.stats.files ?? 0];
  };

  it('reads no table just because the list of inlined tables names it, and says when the inlined rows could not be read, keeping the rows of the files', async () => {
    const plain = await (await edited.open(historyFixture.sqlite)).growthChanges(0);

    const payload = `ducklake_inlined_data_10_12" t UNION ALL SELECT 99, 5, 777, 0, 0, 0 --`;
    const hostile = await (
      await edited.open(
        historyFixture.sqlite,
        `INSERT INTO ducklake_inlined_data_tables VALUES (11, '${payload.replaceAll("'", "''")}', 12)`,
      )
    ).growthChanges(0);
    expect(hostile.changes.some(({ tableId }) => tableId === 99)).toBe(false);
    expect(hostile.changes).toEqual(plain.changes);
    expect(hostile.changes.some(({ tableId }) => tableId === HISTORY_ID.notes)).toBe(true);
    expect([hostile.inlinedMore, hostile.inlinedFailed]).toEqual([undefined, undefined]);

    const failed = await (
      await edited.open(
        historyFixture.sqlite,
        `INSERT INTO ducklake_inlined_data_tables VALUES (11, 'ducklake_inlined_data_11_1', 1)`,
      )
    ).growthChanges(0);
    expect(failed.inlinedFailed).toBe(true);
    expect(failed.changes).toEqual(plain.changes.filter(({ tableId }) => tableId !== HISTORY_ID.notes));
  });

  /** The inlined table of shop.notes, entered once more for `extra` table ids that do not exist. */
  const withCopiesOfNotes = (extra: number): Promise<CatalogReader> =>
    edited.open(
      historyFixture.sqlite,
      ...Array.from(
        { length: extra },
        (_, i) =>
          `INSERT INTO ducklake_inlined_data_tables VALUES (${1000 + i}, 'ducklake_inlined_data_10_12', 12)`,
      ),
    );

  it('reads 200 inlined tables and says nothing is left out; the 201st is not read and the result says so', async () => {
    const exact = await (await withCopiesOfNotes(199)).growthChanges(0);
    const more = await (await withCopiesOfNotes(200)).growthChanges(0);

    expect(exact.inlinedMore).toBeUndefined();
    expect(exact.changes.some(({ tableId }) => tableId === 1000 + 198)).toBe(true);
    expect(more.inlinedMore).toBe(true);
    expect(more.changes.some(({ tableId }) => tableId === 1000 + 198)).toBe(true);
    expect(more.changes.some(({ tableId }) => tableId === 1000 + 199)).toBe(false);
  });

  it('ends a delete file at the earlier of its own end and the end of its data file, as the tree does', async () => {
    const at = [16, 17, 29, 35, 39, 41, 45];
    for (const [deleteEnd, dataEnd] of [
      [30, 40],
      [45, 40],
    ]) {
      const reader = await edited.open(
        historyFixture.sqlite,
        `UPDATE ducklake_delete_file SET end_snapshot = ${deleteEnd} WHERE delete_file_id = 12`,
        `UPDATE ducklake_data_file SET end_snapshot = ${dataEnd} WHERE data_file_id = 9`,
      );
      const { changes } = await reader.growthChanges(0);
      for (const snapshot of at) {
        expect(
          totalOf(changes, HISTORY_ID.customers, snapshot),
          `ends ${deleteEnd}/${dataEnd} at ${snapshot}`,
        ).toEqual(await customersInTree(reader, snapshot));
      }
    }

    // The delete file 12 (2 rows of customers, from snapshot 17) is replaced at 30: the rows come back and the bytes go.
    const replaced = await edited.open(
      historyFixture.sqlite,
      'UPDATE ducklake_delete_file SET end_snapshot = 30 WHERE delete_file_id = 12',
    );
    const { changes } = await replaced.growthChanges(0);
    expect(totalOf(changes, HISTORY_ID.customers, 35)).toEqual([7, 2006, 4]);
    expect(await customersInTree(replaced, 35)).toEqual([7, 2006, 4]);
    expect(totalOf(changes, HISTORY_ID.customers, 29)).toEqual([5, 2960, 4]);
  });

  it('ends the mark of a data file that covers later snapshots when the file itself ends before the last of them', async () => {
    // The compaction file 26 of shop.log holds snapshots 51 to 54; it ends at 52.
    const reader = await edited.open(
      historyFixture.sqlite,
      'UPDATE ducklake_data_file SET end_snapshot = 52 WHERE data_file_id = 26',
    );
    const { changes } = await reader.growthChanges(0);

    expect(
      changes
        .filter(({ tableId, partialFiles }) => tableId === HISTORY_ID.log && partialFiles !== 0)
        .map(({ snapshot, partialFiles }) => [snapshot, partialFiles]),
    ).toEqual([
      [51, 1],
      [52, -1],
    ]);
  });
});
