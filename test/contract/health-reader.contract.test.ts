import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { globalValue } from '../../src/catalog/model';
import type { CatalogReader } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { HISTORY_DATA_PATH, HISTORY_ID, HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historySources } from '../support/sources/history';

const FIXTURE_V1_0 = fileURLToPath(new URL('../fixtures/ducklake-1.0.sqlite', import.meta.url));

const { events, readings, customers, notes, evolving, log, oldStuff } = HISTORY_ID;

// What the health check reads from the catalog, on the history fixture in each engine: the same catalog, the same answers.
for (const source of historySources) {
  const skipReason = source.skipReason();
  describe.skipIf(skipReason !== undefined)(
    `health reads of the catalog, ${source.name}${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`,
    () => {
      let reader: CatalogReader;

      beforeAll(async () => {
        reader = createCatalogReader(await source.open());
      });
      afterAll(async () => {
        await reader.close();
      });

      it('finds no contradiction in the healthy catalog and counts its small files and inlined rows, for the lake and per table', async () => {
        const lake = await reader.consistency({}, HISTORY_LATEST_SNAPSHOT, 10);
        expect(lake).toEqual({ problems: [], unavailable: [] });
        for (const tableId of [events, readings, customers, notes, evolving, log, oldStuff]) {
          expect(await reader.consistency({ tableId }, HISTORY_LATEST_SNAPSHOT, 10)).toEqual({
            problems: [],
            unavailable: [],
          });
        }

        const facts = await reader.maintenanceFacts({}, 10);
        expect(facts.snapshotGaps).toEqual({ count: 0, missing: 0, first: [] });
        // Only shop.events has the nine files, all of them small; the tables with fewer files are not called out.
        expect(facts.smallFiles).toEqual([{ tableId: events, files: 9, small: 9, smallBytes: 6349 }]);
        expect(facts.inlined).toEqual([{ tableId: notes, rows: 2 }]);
        expect(facts.inlinedMore).toBeUndefined();
        expect((await reader.maintenanceFacts({ tableId: events }, 10)).smallFiles).toEqual([
          { tableId: events, files: 9, small: 9, smallBytes: 6349 },
        ]);
        expect((await reader.maintenanceFacts({ tableId: customers }, 10)).smallFiles).toEqual([]);
      });

      it('lists the files a snapshot still needs with the place of each, limits them, and gives the directory of one table', async () => {
        const base = HISTORY_DATA_PATH[source.name];
        const dataPath = globalValue(await reader.metadata(), 'data_path');
        expect(dataPath).toBe(base);
        const places = await reader.fileLocations({}, dataPath, 100);

        expect(places.more).toBe(false);
        expect(places.directory).toBeNull();
        // 20 data files (one of the dropped table, which only older snapshots need) and one delete file.
        expect(places.files.filter((file) => file.kind === 'data')).toHaveLength(20);
        expect(places.files.filter((file) => file.kind === 'delete')).toHaveLength(1);
        expect(places.files.filter((file) => file.endSnapshot !== null).map((file) => file.id)).toEqual([21]);
        const eventsFile = places.files.find((file) => file.kind === 'data' && file.id === 0);
        expect(eventsFile).toMatchObject({
          tableId: events,
          schema: 'shop',
          table: 'events',
          beginSnapshot: 6,
          endSnapshot: null,
          sizeBytes: 658,
          records: 3,
          encrypted: false,
          format: 'parquet',
        });
        expect(places.files.every((file) => file.format === 'parquet')).toBe(true);
        expect(places.shared).toEqual([]);
        expect(eventsFile?.location).toMatch(
          new RegExp(
            `^${base.replaceAll('/', '\\/')}shop\\/events\\/kind=click\\/year=2025\\/ducklake-[0-9a-f-]+\\.parquet$`,
          ),
        );
        // A renamed table keeps its directory and the name it has now.
        expect(places.files.find((file) => file.id === 19)).toMatchObject({
          table: 'evolved',
          schema: 'main',
        });
        expect(places.files.find((file) => file.id === 19)?.location).toContain('/main/evolving/');
        // The five files that maintenance scheduled for deletion, as full paths.
        expect(places.scheduled).toHaveLength(5);
        expect(places.scheduled.every((path) => path.startsWith(`${base}shop/`))).toBe(true);
        expect(places.moreScheduled).toBe(false);

        const limited = await reader.fileLocations({}, dataPath, 5);
        expect(limited.files).toHaveLength(5);
        expect(limited.more).toBe(true);
        expect(limited.scheduled).toHaveLength(5);
        expect((await reader.fileLocations({}, dataPath, 4)).moreScheduled).toBe(true);

        const ofEvents = await reader.fileLocations({ tableId: events }, dataPath, 100);
        expect(ofEvents.directory).toBe(`${base}shop/events/`);
        expect(ofEvents.shared).toEqual([]);
        expect(ofEvents.files).toHaveLength(9);
        expect(
          ofEvents.files.every(
            (file) => file.tableId === events && file.location?.startsWith(ofEvents.directory ?? '!'),
          ),
        ).toBe(true);
      });

      it('names every top-level column a table ever had, by id', async () => {
        expect(await reader.columnHistory(evolving)).toEqual([
          { id: 1, name: 'id' },
          { id: 2, name: 'name' },
          { id: 2, name: 'title' },
          { id: 3, name: 'info' },
          { id: 6, name: 'n' },
          { id: 7, name: 'extra' },
          { id: 9, name: 'flag' },
        ]);
      });
    },
  );
}

// A catalog of specification 1.0 lacks columns and tables that 1.1 added; the health reads only use what 1.0 has.
describe('health reads of the catalog of specification 1.0', () => {
  it('runs every check and finds nothing, and places the files like the catalog of 1.1', async () => {
    const reader = createCatalogReader(await openSqlite({ path: FIXTURE_V1_0, wasmPath }));
    try {
      const { latestSnapshot, specVersion } = await reader.info();
      expect(specVersion).toBe('1.0');
      expect(await reader.consistency({}, latestSnapshot, 10)).toEqual({ problems: [], unavailable: [] });
      expect((await reader.maintenanceFacts({}, 10)).snapshotGaps.count).toBe(0);

      const dataPath = globalValue(await reader.metadata(), 'data_path');
      expect(dataPath).not.toBeNull();
      const places = await reader.fileLocations({}, dataPath, 100);
      expect(places.files.length).toBeGreaterThan(0);
      expect(places.files.every((file) => file.location !== null && file.sizeBytes !== null)).toBe(true);
      expect(places.files.every((file) => file.format === 'parquet')).toBe(true);
    } finally {
      await reader.close();
    }
  });
});
