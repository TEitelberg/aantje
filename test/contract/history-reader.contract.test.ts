import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver } from '../../src/catalog/drivers/driver';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader, ResolvedChange } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { diffColumns, diffEntries } from '../../src/catalog/schema-diff';
import { ID as FIXTURE_ID, LATEST_SNAPSHOT as FIXTURE_LATEST } from '../support/expected';
import {
  EVENTS_PARTITIONING_BY_MONTH,
  EVENTS_PARTITIONING_BY_YEAR,
  EXPIRED_SCHEDULED_FOR_DELETION,
  EXPIRED_SNAPSHOTS,
  GROSS_MACRO,
  HISTORY_COMMIT,
  HISTORY_DATA_PATH,
  HISTORY_FILES_AT,
  HISTORY_ID,
  HISTORY_LATEST_SNAPSHOT,
  HISTORY_METADATA_KEYS,
  HISTORY_ROWS,
  HISTORY_SNAPSHOT,
  LEGACY_FEE_MACRO,
  READINGS_SORT_BY_SENSOR,
  READINGS_SORT_BY_VALUE,
  RECENT_EVENTS_MACRO,
  SCHEDULED_FOR_DELETION,
} from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture, historySources } from '../support/sources/history';

/** Same statements as the main fixture, written by DuckDB 1.5 (DuckLake specification 1.0). */
const FIXTURE_V1_0 = fileURLToPath(new URL('../fixtures/ducklake-1.0.sqlite', import.meta.url));

const change = (
  raw: string,
  action: ResolvedChange['action'],
  object: ResolvedChange['object'],
  objectId: number | null,
  schemaName: string | null,
  name: string | null,
): ResolvedChange => ({ action, object, objectId, schemaName, name, raw });

const { mainSchema, shopSchema, events, customers, notes, audit, evolving, log } = HISTORY_ID;

/** The objects that each snapshot of the history fixture changed, also when the snapshot dropped them. */
const CHANGES_OF_SNAPSHOT: ReadonlyArray<readonly [number, ResolvedChange[]]> = [
  [HISTORY_SNAPSHOT.createMain, [change('created_schema:"main"', 'created', 'schema', 0, null, 'main')]],
  [HISTORY_SNAPSHOT.dropScratch, [change('dropped_schema:2', 'dropped', 'schema', 2, null, 'scratch')]],
  [
    HISTORY_SNAPSHOT.updateCustomer,
    [
      change('inserted_into_table:9', 'inserted', 'table', customers, 'shop', 'customers'),
      change('deleted_from_table:9', 'deleted', 'table', customers, 'shop', 'customers'),
    ],
  ],
  [
    HISTORY_SNAPSHOT.updateNote,
    [
      change('inlined_insert:10', 'inlined_insert', 'table', notes, 'shop', 'notes'),
      change('inlined_delete:10', 'inlined_delete', 'table', notes, 'shop', 'notes'),
    ],
  ],
  [
    HISTORY_SNAPSHOT.twoTablesInOneTransaction,
    [
      change('inserted_into_table:3', 'inserted', 'table', events, 'shop', 'events'),
      change('inserted_into_table:9', 'inserted', 'table', customers, 'shop', 'customers'),
    ],
  ],
  [
    HISTORY_SNAPSHOT.createAndInsertInOneTransaction,
    [
      change('created_table:"shop"."audit"', 'created', 'table', audit, 'shop', 'audit'),
      change('inserted_into_table:11', 'inserted', 'table', audit, 'shop', 'audit'),
    ],
  ],
  [
    HISTORY_SNAPSHOT.dropExtraColumn,
    [change('altered_table:12', 'altered', 'table', evolving, 'main', 'evolving')],
  ],
  [
    HISTORY_SNAPSHOT.renameColumn,
    [change('altered_table:12', 'altered', 'table', evolving, 'main', 'evolving')],
  ],
  [
    HISTORY_SNAPSHOT.insertEvolved,
    [change('inserted_into_table:12', 'inserted', 'table', evolving, 'main', 'evolved')],
  ],
  [
    HISTORY_SNAPSHOT.renameTable,
    [change('created_table:"main"."evolved"', 'renamed', 'table', evolving, 'main', 'evolved')],
  ],
  [
    HISTORY_SNAPSHOT.createBigEventsView,
    [change('created_view:"shop"."big_events"', 'created', 'view', 13, 'shop', 'big_events')],
  ],
  [HISTORY_SNAPSHOT.commentOnView, [change('altered_view:13', 'altered', 'view', 13, 'shop', 'big_events')]],
  [HISTORY_SNAPSHOT.dropTmpView, [change('dropped_view:14', 'dropped', 'view', 14, 'shop', 'tmp_view')]],
  [HISTORY_SNAPSHOT.dropOldStuff, [change('dropped_table:15', 'dropped', 'table', 15, 'shop', 'old_stuff')]],
  [
    HISTORY_SNAPSHOT.createGrossMacro,
    [change('created_scalar_macro:"shop"."gross"', 'created', 'scalar_macro', 16, 'shop', 'gross')],
  ],
  [
    HISTORY_SNAPSHOT.createRecentEventsMacro,
    [
      change(
        'created_table_macro:"shop"."recent_events"',
        'created',
        'table_macro',
        17,
        'shop',
        'recent_events',
      ),
    ],
  ],
  [
    HISTORY_SNAPSHOT.dropLegacyFeeMacro,
    [change('dropped_scalar_macro:18', 'dropped', 'scalar_macro', 18, 'shop', 'legacy_fee')],
  ],
  [HISTORY_SNAPSHOT.mergeLog, [change('merge_adjacent:19', 'merged', 'table', log, 'shop', 'log')]],
];

for (const source of historySources) {
  const skipReason = source.skipReason();
  describe.skipIf(skipReason !== undefined)(
    `catalog reader on the history fixture, ${source.name}${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`,
    () => {
      let reader: CatalogReader;
      /** A second connection for the raw tables that the numbers of the reader are checked against. */
      let raw: Driver;

      beforeAll(async () => {
        reader = createCatalogReader(await source.open());
        raw = await source.open();
      });
      afterAll(async () => {
        await reader.close();
        await raw.close();
      });

      const rawNumber = async (sql: string): Promise<number> =>
        Number((await raw.query(sql))[0]?.total ?? Number.NaN);

      it('reads the metadata and the snapshot times of the catalog', async () => {
        const properties = await reader.properties();
        expect(properties).toMatchObject({
          specVersion: '1.1',
          dataPath: HISTORY_DATA_PATH[source.name],
          encrypted: false,
          snapshotCount: HISTORY_LATEST_SNAPSHOT + 1,
        });
        expect(properties.createdBy).toMatch(/^DuckDB /);
        expect(properties.metadata.map(({ key }) => key)).toEqual(HISTORY_METADATA_KEYS);
        // The one entry with a scope is the data inlining option of shop.notes.
        expect(properties.metadata.at(-1)).toEqual({
          key: 'data_inlining_row_limit',
          value: '10',
          scope: 'table',
          scopeId: HISTORY_ID.notes,
        });

        const snapshots = await reader.snapshots();
        const { firstSnapshotTime, latestSnapshotTime } = properties;
        expect(firstSnapshotTime).toBe(snapshots.at(-1)?.time);
        expect(latestSnapshotTime).toBe(snapshots[0]?.time);
        expect(firstSnapshotTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect((firstSnapshotTime ?? '') <= (latestSnapshotTime ?? '')).toBe(true);
      });

      it('counts the data and delete files at every snapshot and reports the files that wait for deletion', async () => {
        for (const [snapshot, [dataFiles, deleteFiles]] of Object.entries(HISTORY_FILES_AT)) {
          const { dataFiles: data, deleteFiles: deletes } = await reader.storage(Number(snapshot));
          const visible = (table: string) =>
            rawNumber(
              `SELECT CAST(SUM(file_size_bytes) AS BIGINT) AS total FROM ${table}
                WHERE begin_snapshot <= ${snapshot} AND (end_snapshot IS NULL OR end_snapshot > ${snapshot})`,
            );
          expect(data.count, `data files at @${snapshot}`).toBe(dataFiles);
          expect(deletes.count, `delete files at @${snapshot}`).toBe(deleteFiles);
          expect(data.sizeBytes, `data bytes at @${snapshot}`).toBe(
            dataFiles === 0 ? 0 : await visible('ducklake_data_file'),
          );
          expect(deletes.sizeBytes, `delete bytes at @${snapshot}`).toBe(
            deleteFiles === 0 ? 0 : await visible('ducklake_delete_file'),
          );
        }

        const storage = await reader.storage(HISTORY_LATEST_SNAPSHOT);
        expect(storage).toMatchObject({
          dataPath: HISTORY_DATA_PATH[source.name],
          encrypted: false,
          scheduledForDeletion: { count: SCHEDULED_FOR_DELETION.length },
        });
        expect(storage.scheduledForDeletion.oldestScheduledAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      });

      it('shows the partitioning and the sort order that are in force at a snapshot', async () => {
        const partitioning = (snapshot: number) => reader.partitioning(events, snapshot);
        await expect(partitioning(HISTORY_SNAPSHOT.createEvents)).resolves.toBeUndefined();
        await expect(partitioning(HISTORY_SNAPSHOT.partitionEventsByYear)).resolves.toEqual(
          EVENTS_PARTITIONING_BY_YEAR,
        );
        await expect(partitioning(HISTORY_SNAPSHOT.insertEventsBulk)).resolves.toEqual(
          EVENTS_PARTITIONING_BY_YEAR,
        );
        await expect(partitioning(HISTORY_SNAPSHOT.partitionEventsByMonth)).resolves.toEqual(
          EVENTS_PARTITIONING_BY_MONTH,
        );
        await expect(partitioning(HISTORY_LATEST_SNAPSHOT)).resolves.toEqual(EVENTS_PARTITIONING_BY_MONTH);
        await expect(
          reader.partitioning(HISTORY_ID.readings, HISTORY_LATEST_SNAPSHOT),
        ).resolves.toBeUndefined();

        const sort = (snapshot: number) => reader.sortOrder(HISTORY_ID.readings, snapshot);
        await expect(sort(HISTORY_SNAPSHOT.createReadings)).resolves.toBeUndefined();
        await expect(sort(HISTORY_SNAPSHOT.sortReadingsBySensor)).resolves.toEqual(READINGS_SORT_BY_SENSOR);
        await expect(sort(HISTORY_SNAPSHOT.insertReadings)).resolves.toEqual(READINGS_SORT_BY_SENSOR);
        await expect(sort(HISTORY_SNAPSHOT.sortReadingsByValue)).resolves.toEqual(READINGS_SORT_BY_VALUE);
        await expect(sort(HISTORY_LATEST_SNAPSHOT)).resolves.toEqual(READINGS_SORT_BY_VALUE);
        await expect(reader.sortOrder(events, HISTORY_LATEST_SNAPSHOT)).resolves.toBeUndefined();
      });

      it('has no tags besides the comments, and lists the macros that exist at a snapshot by name', async () => {
        await expect(reader.tags(customers, HISTORY_LATEST_SNAPSHOT)).resolves.toEqual({
          table: [],
          columns: [],
        });
        const [tier] = (await reader.columns(customers, HISTORY_LATEST_SNAPSHOT)).slice(-1);
        expect(tier?.comment).toBe('bronze, silver or gold');

        const macros = (snapshot: number) => reader.macros(shopSchema, snapshot);
        await expect(macros(HISTORY_SNAPSHOT.dropOldStuff)).resolves.toEqual([]);
        await expect(macros(HISTORY_SNAPSHOT.createGrossMacro)).resolves.toEqual([GROSS_MACRO]);
        await expect(macros(HISTORY_SNAPSHOT.createRecentEventsMacro)).resolves.toEqual([
          GROSS_MACRO,
          RECENT_EVENTS_MACRO,
        ]);
        await expect(macros(HISTORY_SNAPSHOT.createLegacyFeeMacro)).resolves.toEqual([
          GROSS_MACRO,
          LEGACY_FEE_MACRO,
          RECENT_EVENTS_MACRO,
        ]);
        await expect(macros(HISTORY_SNAPSHOT.dropLegacyFeeMacro)).resolves.toEqual([
          GROSS_MACRO,
          RECENT_EVENTS_MACRO,
        ]);
        await expect(reader.macros(mainSchema, HISTORY_LATEST_SNAPSHOT)).resolves.toEqual([]);

        // All schemas in one statement: the same objects as schema by schema.
        const schemas = await reader.schemas(HISTORY_LATEST_SNAPSHOT);
        const byId = <T extends { readonly id: number }>(list: readonly T[]): T[] =>
          list.toSorted((a, b) => a.id - b.id);
        const each = async <T extends { readonly id: number }>(
          read: (schemaId: number) => Promise<readonly T[]>,
        ): Promise<T[]> => byId((await Promise.all(schemas.map(({ id }) => read(id)))).flat());
        expect(byId(await reader.macros(null, HISTORY_LATEST_SNAPSHOT))).toEqual(
          await each((id) => reader.macros(id, HISTORY_LATEST_SNAPSHOT)),
        );
        const views = await reader.views(null, HISTORY_LATEST_SNAPSHOT);
        expect(views.length).toBeGreaterThan(0);
        expect(byId(views)).toEqual(await each((id) => reader.views(id, HISTORY_LATEST_SNAPSHOT)));
      });

      it('names the objects that a snapshot changed, also when it dropped them, and none for a missing snapshot', async () => {
        for (const [snapshot, expected] of CHANGES_OF_SNAPSHOT) {
          expect(await reader.snapshotChanges(snapshot), `changes of @${snapshot}`).toEqual(expected);
        }
        await expect(reader.snapshotChanges(HISTORY_LATEST_SNAPSHOT + 1)).resolves.toEqual([]);
      });

      it('lists every snapshot newest first with its commit data and the changes resolved like snapshotChanges', async () => {
        const { snapshots, more } = await reader.snapshotActivity();
        const listed = await reader.snapshots();
        expect(more).toBe(false);
        expect(snapshots.map(({ id }) => id)).toEqual(listed.map(({ id }) => id));
        expect(snapshots).toHaveLength(HISTORY_LATEST_SNAPSHOT + 1);
        for (const snapshot of snapshots) {
          expect(snapshot.time, `time of @${snapshot.id}`).toBe(
            listed.find(({ id }) => id === snapshot.id)?.time,
          );
          expect(snapshot.changes, `changes of @${snapshot.id}`).toEqual(
            await reader.snapshotChanges(snapshot.id),
          );
        }

        // Author, message and extra info sit on the snapshot that set them and are null elsewhere.
        const commit = {
          author: HISTORY_COMMIT.author,
          commitMessage: HISTORY_COMMIT.message,
          commitExtraInfo: HISTORY_COMMIT.extraInfo,
        };
        expect(listed.find(({ id }) => id === HISTORY_COMMIT.snapshot)).toMatchObject(commit);
        expect(snapshots.find(({ id }) => id === HISTORY_COMMIT.snapshot)).toMatchObject({
          author: HISTORY_COMMIT.author,
          commitMessage: HISTORY_COMMIT.message,
          changes: [change('inserted_into_table:9', 'inserted', 'table', customers, 'shop', 'customers')],
        });
        const others = listed.filter(({ id }) => id !== HISTORY_COMMIT.snapshot);
        expect(others).toHaveLength(HISTORY_LATEST_SNAPSHOT);
        expect(
          others.every((s) => s.author === null && s.commitMessage === null && s.commitExtraInfo === null),
        ).toBe(true);
        expect(
          snapshots.filter(({ author, commitMessage }) => author !== null || commitMessage !== null),
        ).toHaveLength(1);
      });

      it('returns the newest snapshots up to a limit and only those of a range, both ends included', async () => {
        const { snapshots, more } = await reader.snapshotActivity(10);
        expect(snapshots.map(({ id }) => id)).toEqual([56, 55, 54, 53, 52, 51, 50, 49, 48, 47]);
        expect(more).toBe(true);
        await expect(reader.snapshotActivity(HISTORY_LATEST_SNAPSHOT + 1)).resolves.toMatchObject({
          more: false,
        });
        await expect(reader.snapshotActivity(0)).resolves.toEqual({ snapshots: [], more: true });

        const ids = async (limit: number, range: { from?: number; to?: number }) => {
          const page = await reader.snapshotActivity(limit, range);
          return [page.snapshots.map(({ id }) => id), page.more] as const;
        };
        await expect(ids(500, { from: 20, to: 24 })).resolves.toEqual([[24, 23, 22, 21, 20], false]);
        await expect(ids(2, { from: 20, to: 24 })).resolves.toEqual([[24, 23], true]);
        await expect(ids(500, { from: 55 })).resolves.toEqual([[56, 55], false]);
        await expect(ids(3, { to: 2 })).resolves.toEqual([[2, 1, 0], false]);
        await expect(ids(500, { from: 90 })).resolves.toEqual([[], false]);

        // A range of one snapshot still names the table that this snapshot created.
        const created = await reader.snapshotActivity(500, {
          from: HISTORY_SNAPSHOT.createEvents,
          to: HISTORY_SNAPSHOT.createEvents,
        });
        expect(
          created.snapshots.map(({ id, changes }) => [
            id,
            changes.map(({ name, schemaName, objectId }) => [name, schemaName, objectId]),
          ]),
        ).toEqual([[HISTORY_SNAPSHOT.createEvents, [['events', 'shop', events]]]]);
      });

      it('gives the lifetime of a table or view from its first snapshot to the one that dropped it, agreeing with the entries', async () => {
        // Table 12 is `evolving` from 26 and `evolved` from 35: the first version ends at 35, the second never.
        await expect(reader.lifetime('table', evolving)).resolves.toEqual({
          begin: HISTORY_SNAPSHOT.createEvolving,
          end: null,
        });
        await expect(reader.lifetime('table', events)).resolves.toEqual({
          begin: HISTORY_SNAPSHOT.createEvents,
          end: null,
        });
        await expect(reader.lifetime('table', HISTORY_ID.oldStuff)).resolves.toEqual({
          begin: HISTORY_SNAPSHOT.createOldStuff,
          end: HISTORY_SNAPSHOT.dropOldStuff,
        });
        await expect(reader.lifetime('view', HISTORY_ID.tmpView)).resolves.toEqual({
          begin: HISTORY_SNAPSHOT.createTmpView,
          end: HISTORY_SNAPSHOT.dropTmpView,
        });
        await expect(reader.lifetime('view', HISTORY_ID.bigEventsView)).resolves.toEqual({
          begin: HISTORY_SNAPSHOT.createBigEventsView,
          end: null,
        });
        // An id of another kind or of no object has none.
        await expect(reader.lifetime('view', evolving)).resolves.toBeUndefined();
        await expect(reader.lifetime('table', HISTORY_ID.bigEventsView)).resolves.toBeUndefined();
        await expect(reader.lifetime('table', 9999)).resolves.toBeUndefined();

        for (const [kind, id] of [
          ['table', HISTORY_ID.oldStuff],
          ['view', HISTORY_ID.tmpView],
        ] as const) {
          const lifetime = await reader.lifetime(kind, id);
          for (let snapshot = 0; snapshot <= HISTORY_LATEST_SNAPSHOT; snapshot++) {
            const exists = (await reader.entries(snapshot)).some(
              (entry) => entry.kind === kind && entry.id === id,
            );
            const inside =
              snapshot >= (lifetime?.begin ?? Infinity) && snapshot < (lifetime?.end ?? Infinity);
            expect(inside, `${kind} ${id} at snapshot ${snapshot}`).toBe(exists);
          }
        }
      });

      describe('statistics of tables whose files hold several snapshots', () => {
        const statsOf = async (tableName: string, snapshot: number) =>
          (await reader.tables(shopSchema, snapshot)).find(({ name }) => name === tableName)?.stats;

        it('marks the rows of shared delete files and compacted files as not exact until the last snapshot they hold', async () => {
          // One delete file (begin 17, partial_max 18) holds both deletes: at snapshot 17 its count is one too high.
          const customersStats = await statsOf('customers', HISTORY_SNAPSHOT.updateCustomer);
          expect(customersStats).toMatchObject({ rows: 3, files: 2, approximate: true });
          expect(HISTORY_ROWS.customersAt[17]).toBe(4);

          // The merged file of shop.log (begin 51, partial_max 54) is the only one at snapshot 52, with 4 rows; the
          // table had 2 then.
          await expect(statsOf('log', 52)).resolves.toMatchObject({ rows: 4, approximate: true });
          const exact = await statsOf('log', 54);
          expect(exact).toMatchObject({ rows: HISTORY_ROWS.logAt[54], files: 1 });
          expect(exact).not.toHaveProperty('approximate');
        });

        it('is exact wherever it does not say otherwise, and does not count rows that stay inline', async () => {
          const cases = [
            ['events', HISTORY_ROWS.eventsAt],
            ['customers', HISTORY_ROWS.customersAt],
            ['log', HISTORY_ROWS.logAt],
          ] as const;
          let exact = 0;
          for (const [name, rows] of cases) {
            for (const [snapshot, count] of Object.entries(rows)) {
              const stats = await statsOf(name, Number(snapshot));
              if (stats?.approximate !== true) {
                expect(stats?.rows, `${name} at snapshot ${snapshot}`).toBe(count);
                exact++;
              }
            }
          }
          // Only customers at 17 is not exact among the snapshots that the engine counted.
          expect(exact).toBe(
            Object.keys(HISTORY_ROWS.eventsAt).length + 5 + Object.keys(HISTORY_ROWS.logAt).length,
          );

          // shop.notes holds 3 rows at snapshot 20 in ducklake_inlined_data_10_12, no Parquet file.
          await expect(statsOf('notes', HISTORY_SNAPSHOT.insertNotes)).resolves.toEqual({
            rows: 0,
            files: 0,
            sizeBytes: 0,
          });
          expect(HISTORY_ROWS.notesAt[20]).toBe(3);
        });
      });
    },
  );
}

/** SQLite catalogs that are edited with sql.js, for what the generated fixtures do not show. */
describe('catalog reader on edited copies of the history fixture', () => {
  let directory: string;
  const opened: Driver[] = [];

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'aantje-history-reader-'));
  });
  afterAll(async () => {
    await Promise.all(opened.map((driver) => driver.close()));
    rmSync(directory, { recursive: true, force: true });
  });

  /** Opens a copy of `source` after `statements` ran on it. */
  async function catalogWith(name: string, source: string, ...statements: string[]): Promise<CatalogReader> {
    const wasm = readFileSync(wasmPath);
    const SQL = await initSqlJs({
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    });
    const db = new SQL.Database(readFileSync(source));
    for (const statement of statements) {
      db.run(statement);
    }
    const path = join(directory, name);
    writeFileSync(path, db.export());
    db.close();
    const driver = await openSqlite({ path, wasmPath });
    opened.push(driver);
    return createCatalogReader(driver);
  }

  /** The id, schema and name of what the changes of a snapshot name. */
  const named = (changes: readonly ResolvedChange[]) =>
    changes.map(({ object, schemaName, name, objectId }) => [object, schemaName, name, objectId]);

  describe('schema differences read from the catalog', () => {
    it('finds added, renamed, retyped, dropped and defaulted columns and the evolution as a whole', async () => {
      const reader = await catalogWith('schema-diff.sqlite', historyFixture.sqlite);
      const columnsAt = (snapshot: number) => reader.columns(evolving, snapshot);
      const diff = async (from: number, to: number) =>
        diffColumns(await columnsAt(from), await columnsAt(to));
      const S = HISTORY_SNAPSHOT;
      const steps = [
        [S.insertEvolving, S.addExtraColumn, [{ change: 'added', id: 7, path: ['extra'], type: 'float64' }]],
        [S.addExtraColumn, S.renameColumn, [{ change: 'renamed', id: 2, path: ['title'], from: 'name' }]],
        [
          S.renameColumn,
          S.widenColumn,
          [{ change: 'typeChanged', id: 6, path: ['n'], from: 'int32', to: 'int64' }],
        ],
        [S.widenColumn, S.dropExtraColumn, [{ change: 'removed', id: 7, path: ['extra'], type: 'float64' }]],
        [
          S.dropExtraColumn,
          S.addStructField,
          [{ change: 'added', id: 8, path: ['info', 'c'], type: 'float64' }],
        ],
        [S.addStructField, S.addFlagColumn, [{ change: 'added', id: 9, path: ['flag'], type: 'boolean' }]],
        [
          S.addFlagColumn,
          S.changeFlagDefault,
          [{ change: 'defaultChanged', id: 9, path: ['flag'], from: 'false', to: 'true' }],
        ],
        // The whole evolution in table order, without the column that came and went.
        [
          S.createEvolving,
          S.changeFlagDefault,
          [
            { change: 'renamed', id: 2, path: ['title'], from: 'name' },
            { change: 'added', id: 8, path: ['info', 'c'], type: 'float64' },
            { change: 'typeChanged', id: 6, path: ['n'], from: 'int32', to: 'int64' },
            { change: 'added', id: 9, path: ['flag'], type: 'boolean' },
          ],
        ],
        // Two snapshots that did not change the table.
        [S.renameTable, HISTORY_LATEST_SNAPSHOT, []],
      ] as const;
      for (const [from, to, expected] of steps) {
        expect(await diff(from, to), `columns @${from} to @${to}`).toEqual(expected);
      }

      expect(
        diffColumns(
          await reader.columns(customers, S.commentOnCustomers),
          await reader.columns(customers, S.commentOnTier),
        ),
      ).toEqual([
        { change: 'commentChanged', id: 3, path: ['tier'], from: null, to: 'bronze, silver or gold' },
      ]);
    });

    it('finds a renamed, a created and a dropped table or view between catalog states', async () => {
      const reader = await catalogWith('entries-diff.sqlite', historyFixture.sqlite);
      const between = async (from: number, to: number) =>
        diffEntries(await reader.entries(from), await reader.entries(to));
      const S = HISTORY_SNAPSHOT;
      expect(await between(S.changeFlagDefault, S.renameTable)).toEqual([
        {
          change: 'renamed',
          kind: 'table',
          id: evolving,
          schemaName: 'main',
          name: 'evolved',
          from: { schemaName: 'main', name: 'evolving' },
        },
      ]);
      expect(await between(S.commentOnTier, S.createBigEventsView)).toEqual([
        { change: 'added', kind: 'view', id: 13, schemaName: 'shop', name: 'big_events' },
      ]);
      expect(await between(S.createTmpView, S.dropTmpView)).toEqual([
        { change: 'dropped', kind: 'view', id: 14, schemaName: 'shop', name: 'tmp_view' },
      ]);
      expect(await between(S.insertOldStuff, S.dropOldStuff)).toEqual([
        { change: 'dropped', kind: 'table', id: 15, schemaName: 'shop', name: 'old_stuff' },
      ]);
    });
  });

  it('gives every object of a snapshot its own id and schema in the changes and the activity', async () => {
    // A schema that begins in the snapshot of its first table still names the schema of the table.
    const sameSnapshot = await catalogWith(
      'schema-same-snapshot.sqlite',
      historyFixture.sqlite,
      `UPDATE ducklake_schema SET begin_snapshot = ${HISTORY_SNAPSHOT.createEvents} WHERE schema_id = ${shopSchema}`,
    );
    await expect(sameSnapshot.snapshotChanges(HISTORY_SNAPSHOT.createEvents)).resolves.toContainEqual(
      change('created_table:"shop"."events"', 'created', 'table', events, 'shop', 'events'),
    );

    // Tables of the same name that one snapshot created in two schemas.
    const twoSchemas = await catalogWith(
      'same-name.sqlite',
      historyFixture.sqlite,
      "INSERT INTO ducklake_snapshot VALUES (700, '2026-11-01 00:00:00+00', 1, 70, 28)",
      `INSERT INTO ducklake_snapshot_changes VALUES (700, 'created_schema:"a",created_schema:"b",created_table:"a"."t",created_table:"b"."t"', NULL, NULL, NULL)`,
      "INSERT INTO ducklake_schema (schema_id, schema_uuid, begin_snapshot, schema_name, path, path_is_relative) VALUES (50, 'schema-a', 700, 'a', 'a/', 1), (51, 'schema-b', 700, 'b', 'b/', 1)",
      "INSERT INTO ducklake_table VALUES (60, 'table-60', 700, NULL, 50, 't', 't/', 1), (61, 'table-61', 700, NULL, 51, 't', 't/', 1)",
      "INSERT INTO ducklake_snapshot VALUES (701, '2026-11-01 00:00:01+00', 1, 70, 28)",
      `INSERT INTO ducklake_snapshot_changes VALUES (701, 'inserted_into_table:60,inserted_into_table:60', NULL, NULL, NULL)`,
    );
    expect(named(await twoSchemas.snapshotChanges(700))).toEqual([
      ['schema', null, 'a', 50],
      ['schema', null, 'b', 51],
      ['table', 'a', 't', 60],
      ['table', 'b', 't', 61],
    ]);

    // Two tables that one snapshot created in the same schema, in the activity of the snapshot.
    const sameSchema = await catalogWith(
      'same-snapshot.sqlite',
      historyFixture.sqlite,
      "INSERT INTO ducklake_snapshot VALUES (700, '2026-11-01 00:00:00+00', 1, 70, 28)",
      `INSERT INTO ducklake_snapshot_changes VALUES (700, 'created_table:"shop"."p",created_table:"shop"."q"', NULL, NULL, NULL)`,
      `INSERT INTO ducklake_table VALUES (60, 'table-60', 700, NULL, ${shopSchema}, 'p', 'p/', 1), (61, 'table-61', 700, NULL, ${shopSchema}, 'q', 'q/', 1)`,
    );
    const { snapshots } = await sameSchema.snapshotActivity(1);
    expect(snapshots[0]?.id).toBe(700);
    expect(snapshots[0]?.changes.map(({ name, objectId }) => [name, objectId])).toEqual([
      ['p', 60],
      ['q', 61],
    ]);

    // A table that one snapshot renamed and filled is named by its new name in both changes.
    const renamedAndFilled = await catalogWith(
      'rename-and-insert.sqlite',
      historyFixture.sqlite,
      `UPDATE ducklake_snapshot_changes SET changes_made = 'created_table:"main"."evolved",inserted_into_table:12' WHERE snapshot_id = ${HISTORY_SNAPSHOT.renameTable}`,
    );
    await expect(renamedAndFilled.snapshotChanges(HISTORY_SNAPSHOT.renameTable)).resolves.toEqual([
      change('created_table:"main"."evolved"', 'renamed', 'table', evolving, 'main', 'evolved'),
      change('inserted_into_table:12', 'inserted', 'table', evolving, 'main', 'evolved'),
    ]);
  });

  it('names every one of 1200 tables of one snapshot across the chunks and keeps a snapshot without changes', async () => {
    const ids = Array.from({ length: 1200 }, (_, index) => 3000 + index);
    const chunked = await catalogWith(
      'chunks.sqlite',
      historyFixture.sqlite,
      "INSERT INTO ducklake_snapshot VALUES (700, '2026-11-01 00:00:00+00', 1, 4300, 28)",
      `INSERT INTO ducklake_snapshot_changes VALUES (700, '${ids.map((id) => `altered_table:${id}`).join(',')}', NULL, NULL, NULL)`,
      `WITH RECURSIVE n(i) AS (SELECT 3000 UNION ALL SELECT i + 1 FROM n WHERE i < 4199)
       INSERT INTO ducklake_table SELECT i, 'uuid-' || i, 5, NULL, ${shopSchema}, 'table_' || i, 't/', 1 FROM n`,
    );
    const { snapshots } = await chunked.snapshotActivity(1);
    expect(snapshots[0]?.changes.map(({ name, objectId }) => [name, objectId])).toEqual(
      ids.map((id) => [`table_${id}`, id]),
    );
    // The changes of that one snapshot, as the tree lists them, go through the same chunks.
    expect((await chunked.snapshotChanges(700)).map(({ name }) => name)).toEqual(
      ids.map((id) => `table_${id}`),
    );

    // A snapshot without a row in the table of changes is still listed, without changes, between its neighbours.
    const gap = await catalogWith(
      'no-changes.sqlite',
      historyFixture.sqlite,
      'DELETE FROM ducklake_snapshot_changes WHERE snapshot_id = 10',
    );
    const range = await gap.snapshotActivity(500, { from: 9, to: 11 });
    expect(range.snapshots.map(({ id, changes }) => [id, changes.length])).toEqual([
      [11, 1],
      [10, 0],
      [9, 1],
    ]);
  });

  it('reads the newest 500 of 20 000 snapshots in bounded time, naming the tables that they create', async () => {
    const reader = await catalogWith(
      'many.sqlite',
      historyFixture.sqlite,
      `WITH RECURSIVE n(i) AS (SELECT 100 UNION ALL SELECT i + 1 FROM n WHERE i < 20099)
       INSERT INTO ducklake_snapshot SELECT i, '2026-11-01 00:00:00+00', 1, 20, 28 FROM n`,
      `WITH RECURSIVE n(i) AS (SELECT 100 UNION ALL SELECT i + 1 FROM n WHERE i < 20099)
       INSERT INTO ducklake_snapshot_changes
       SELECT i, CASE WHEN i % 4 = 0 THEN 'inserted_into_table:3,inserted_into_table:9'
                      WHEN i % 4 = 1 THEN 'created_table:"shop"."t' || i || '"'
                      WHEN i % 4 = 2 THEN 'altered_table:12' ELSE 'merge_adjacent:19' END, NULL, NULL, NULL FROM n`,
      // One table for every snapshot that creates one (101, 105, ...): table id 1000 + (snapshot - 101) / 4.
      `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < 4999)
       INSERT INTO ducklake_table SELECT 1000 + i, 'uuid-' || i, 101 + i * 4, NULL, 1, 't' || (101 + i * 4), 't/', 1 FROM k`,
    );

    const started = performance.now();
    const { snapshots, more } = await reader.snapshotActivity();
    const seconds = (performance.now() - started) / 1000;

    expect(more).toBe(true);
    expect(snapshots).toHaveLength(500);
    expect(snapshots[0]?.id).toBe(20099);
    expect(snapshots.at(-1)?.id).toBe(19600);
    expect(snapshots.find(({ id }) => id === 20097)?.changes).toEqual([
      change('created_table:"shop"."t20097"', 'created', 'table', 1000 + (20097 - 101) / 4, 'shop', 't20097'),
    ]);
    expect(snapshots.find(({ id }) => id === 20096)?.changes.map(({ name }) => name)).toEqual([
      'events',
      'customers',
    ]);
    expect(seconds, 'seconds for 500 snapshots of a catalog with 20 000').toBeLessThan(5);
  });

  it('orders sort expressions by key index, macro parameters by position and tags by key, and keeps a "NULL" default', async () => {
    const ordered = await catalogWith(
      'order.sqlite',
      historyFixture.sqlite,
      // Insertion order is the other way round.
      `UPDATE ducklake_sort_expression SET sort_key_index = CASE expression WHEN 'sensor' THEN 7 ELSE 2 END WHERE sort_id = ${READINGS_SORT_BY_SENSOR.id}`,
      `UPDATE ducklake_macro_parameters SET column_id = CASE parameter_name WHEN 'net' THEN 5 ELSE 3 END WHERE macro_id = ${GROSS_MACRO.id}`,
      `INSERT INTO ducklake_tag VALUES (${customers}, 40, NULL, 'b', '1'), (${customers}, 40, NULL, 'a', '2')`,
    );
    const sort = await ordered.sortOrder(HISTORY_ID.readings, HISTORY_SNAPSHOT.sortReadingsBySensor);
    expect(sort?.expressions.map(({ expression }) => expression)).toEqual(['taken_at', 'sensor']);
    const [gross] = (await ordered.macros(shopSchema, HISTORY_SNAPSHOT.createGrossMacro)).filter(
      ({ id }) => id === GROSS_MACRO.id,
    );
    expect(gross?.implementations[0]?.parameters.map(({ name }) => name)).toEqual(['rate', 'net']);
    expect((await ordered.tags(customers, HISTORY_LATEST_SNAPSHOT)).table.map(({ key }) => key)).toEqual([
      'a',
      'b',
    ]);

    // The text NULL of a macro parameter is a default, the string "NULL": only the type unknown says none.
    const nullDefault = await catalogWith(
      'macro-default.sqlite',
      historyFixture.sqlite,
      `UPDATE ducklake_macro_parameters SET default_value_type = 'varchar' WHERE macro_id = ${GROSS_MACRO.id} AND parameter_name = 'net'`,
    );
    const [grossDefault] = (await nullDefault.macros(shopSchema, HISTORY_SNAPSHOT.createGrossMacro)).filter(
      ({ id }) => id === GROSS_MACRO.id,
    );
    expect(grossDefault?.implementations[0]?.parameters).toEqual([
      { name: 'net', type: null, defaultValue: "'NULL'" },
      { name: 'rate', type: null, defaultValue: '1.19' },
    ]);

    // A sort order that was reset: none from the snapshot of the reset on, the one before it until then.
    const reset = await catalogWith(
      'sort-reset.sqlite',
      historyFixture.sqlite,
      'UPDATE ducklake_sort_info SET end_snapshot = 40 WHERE sort_id = 8',
      `INSERT INTO ducklake_sort_info VALUES (95, ${HISTORY_ID.readings}, 40, NULL)`,
    );
    await expect(reset.sortOrder(HISTORY_ID.readings, 39)).resolves.toEqual({
      ...READINGS_SORT_BY_VALUE,
      endSnapshot: 40,
    });
    await expect(reset.sortOrder(HISTORY_ID.readings, 40)).resolves.toBeUndefined();
    await expect(reset.sortOrder(HISTORY_ID.readings, HISTORY_LATEST_SNAPSHOT)).resolves.toBeUndefined();
  });

  it('lists the tags that are not comments, sorted, from the snapshot that set them until the one that removed them', async () => {
    // Table 9 is shop.customers; column 2 of table 12 is `name` (`title` from snapshot 29 on), column 8 is `info.c`.
    const reader = await catalogWith(
      'tags.sqlite',
      historyFixture.sqlite,
      `INSERT INTO ducklake_tag VALUES
         (9, 40, NULL, 'owner', 'team-a'),
         (9, 40, 50, 'retired', 'gone again'),
         (9, 45, NULL, 'z"quote', 'two' || char(10) || 'lines'),
         (13, 45, NULL, 'view tag', 'other object')`,
      `INSERT INTO ducklake_column_tag VALUES
         (12, 8, 40, NULL, 'pii', 'false'),
         (12, 2, 40, NULL, 'label', 'x'),
         (12, 2, 40, NULL, 'comment', 'not listed'),
         (9, 3, 40, NULL, 'other table', 'no')`,
    );
    await expect(reader.tags(HISTORY_ID.evolving, HISTORY_LATEST_SNAPSHOT)).resolves.toEqual({
      table: [],
      columns: [
        { columnId: 2, path: ['title'], key: 'label', value: 'x' },
        { columnId: 8, path: ['info', 'c'], key: 'pii', value: 'false' },
      ],
    });
    await expect(reader.tags(HISTORY_ID.customers, HISTORY_LATEST_SNAPSHOT)).resolves.toEqual({
      table: [
        { key: 'owner', value: 'team-a' },
        { key: 'z"quote', value: 'two\nlines' },
      ],
      columns: [{ columnId: 3, path: ['tier'], key: 'other table', value: 'no' }],
    });
    const keys = async (snapshot: number) =>
      (await reader.tags(HISTORY_ID.customers, snapshot)).table.map(({ key }) => key);
    await expect(keys(39)).resolves.toEqual([]);
    await expect(keys(40)).resolves.toEqual(['owner', 'retired']);
    await expect(keys(49)).resolves.toEqual(['owner', 'retired', 'z"quote']);
    await expect(keys(50)).resolves.toEqual(['owner', 'z"quote']);

    // Column 2 is called `name` before snapshot 29; the tag exists only from 40, so move it back to see the old name.
    const early = await catalogWith(
      'tags-early.sqlite',
      historyFixture.sqlite,
      `INSERT INTO ducklake_column_tag VALUES (12, 2, 27, NULL, 'label', 'x')`,
    );
    const pathAt = async (snapshot: number) =>
      (await early.tags(HISTORY_ID.evolving, snapshot)).columns.map(({ path }) => path);
    await expect(pathAt(28)).resolves.toEqual([['name']]);
    await expect(pathAt(29)).resolves.toEqual([['title']]);
  });

  it('names a nested partition column by its path as of the asked snapshot and treats a reset as no partitioning', async () => {
    // Table 12: partitioning 90 on `name` from 28, 91 on the struct field info.c and `name` from 33, reset at 36.
    const reader = await catalogWith(
      'partitions.sqlite',
      historyFixture.sqlite,
      `INSERT INTO ducklake_partition_info VALUES (90, 12, 28, 33), (91, 12, 33, 36), (92, 12, 36, NULL)`,
      `INSERT INTO ducklake_partition_column VALUES
         (90, 12, 0, 2, 'identity'),
         (91, 12, 0, 8, 'bucket(4)'),
         (91, 12, 1, 2, 'identity')`,
    );
    await expect(reader.partitioning(HISTORY_ID.evolving, 34)).resolves.toEqual({
      id: 91,
      beginSnapshot: 33,
      endSnapshot: 36,
      columns: [
        { columnId: 8, path: ['info', 'c'], transform: 'bucket(4)' },
        { columnId: 2, path: ['title'], transform: 'identity' },
      ],
    });
    // Partitioning 90 began at snapshot 28, before the column `name` was renamed to `title` at 29.
    const first = async (snapshot: number) =>
      (await reader.partitioning(HISTORY_ID.evolving, snapshot))?.columns[0];
    expect(await first(28)).toEqual({ columnId: 2, path: ['name'], transform: 'identity' });
    expect(await first(30)).toEqual({ columnId: 2, path: ['title'], transform: 'identity' });
    await expect(reader.partitioning(HISTORY_ID.evolving, 40)).resolves.toBeUndefined();
    await expect(reader.partitioning(HISTORY_ID.evolving, 27)).resolves.toBeUndefined();
  });

  it('reads the encryption flag, the oldest scheduled deletion and the lifetime of a renamed table dropped later', async () => {
    const encrypted = await catalogWith(
      'encrypted.sqlite',
      historyFixture.sqlite,
      "UPDATE ducklake_metadata SET value = 'true' WHERE key = 'encrypted'",
    );
    await expect(encrypted.properties()).resolves.toMatchObject({ encrypted: true });
    await expect(encrypted.storage(HISTORY_LATEST_SNAPSHOT)).resolves.toMatchObject({ encrypted: true });

    const scheduled = await catalogWith(
      'scheduled.sqlite',
      historyFixture.sqlite,
      `UPDATE ducklake_files_scheduled_for_deletion SET schedule_start = CASE data_file_id
         WHEN 22 THEN '2026-03-05 08:30:00+00'
         WHEN 25 THEN '2026-07-01 00:00:00+00'
         ELSE '2026-05-01 12:00:00+00' END`,
    );
    const { scheduledForDeletion } = await scheduled.storage(HISTORY_LATEST_SNAPSHOT);
    expect(scheduledForDeletion).toEqual({
      count: SCHEDULED_FOR_DELETION.length,
      oldestScheduledAt: '2026-03-05T08:30:00.000Z',
      // Every file was scheduled months ago, so with the default age of 2 days all are ready.
      split: {
        age: { text: '2 days', source: 'default' },
        ready: SCHEDULED_FOR_DELETION.length,
        waiting: 0,
        nextReadyAt: null,
      },
    });

    // The lifetime ends at the drop, not at the rename that ended the first version.
    const dropped = await catalogWith(
      'dropped-renamed.sqlite',
      historyFixture.sqlite,
      'UPDATE ducklake_table SET end_snapshot = 40 WHERE table_id = 12 AND end_snapshot IS NULL',
    );
    await expect(dropped.lifetime('table', HISTORY_ID.evolving)).resolves.toEqual({ begin: 26, end: 40 });
  });

  it('reads a catalog that lacks the optional tables and columns and answers "nothing there"', async () => {
    const reader = await catalogWith(
      'old.sqlite',
      historyFixture.sqlite,
      'ALTER TABLE ducklake_snapshot_changes DROP COLUMN author',
      'ALTER TABLE ducklake_snapshot_changes DROP COLUMN commit_message',
      'ALTER TABLE ducklake_snapshot_changes DROP COLUMN commit_extra_info',
      'DROP TABLE ducklake_partition_column',
      'DROP TABLE ducklake_partition_info',
      'DROP TABLE ducklake_sort_expression',
      'DROP TABLE ducklake_sort_info',
      'DROP TABLE ducklake_macro_parameters',
      'DROP TABLE ducklake_macro_impl',
      'DROP TABLE ducklake_macro',
      'DROP TABLE ducklake_column_tag',
      'DROP TABLE ducklake_files_scheduled_for_deletion',
    );

    const listed = await reader.snapshots();
    expect(listed).toHaveLength(HISTORY_LATEST_SNAPSHOT + 1);
    expect(listed.find(({ id }) => id === HISTORY_COMMIT.snapshot)).toMatchObject({
      changes: 'inserted_into_table:9',
      author: null,
      commitMessage: null,
      commitExtraInfo: null,
    });

    const latest = HISTORY_LATEST_SNAPSHOT;
    await expect(reader.partitioning(HISTORY_ID.events, latest)).resolves.toBeUndefined();
    await expect(reader.sortOrder(HISTORY_ID.readings, latest)).resolves.toBeUndefined();
    await expect(reader.macros(shopSchema, latest)).resolves.toEqual([]);
    await expect(reader.tags(HISTORY_ID.customers, latest)).resolves.toEqual({ table: [], columns: [] });
    const storage = await reader.storage(latest);
    expect(storage.scheduledForDeletion).toMatchObject({ count: 0, oldestScheduledAt: null });
    expect(storage.dataFiles.count).toBe(HISTORY_FILES_AT[56][0]);

    // A macro is named only as far as the change names it, a dropped one without a name.
    const createdMacro = change(
      'created_scalar_macro:"shop"."gross"',
      'created',
      'scalar_macro',
      null,
      'shop',
      'gross',
    );
    const droppedMacro = change('dropped_scalar_macro:18', 'dropped', 'scalar_macro', 18, null, null);
    await expect(reader.snapshotChanges(HISTORY_SNAPSHOT.createGrossMacro)).resolves.toEqual([createdMacro]);
    await expect(reader.snapshotChanges(HISTORY_SNAPSHOT.dropLegacyFeeMacro)).resolves.toEqual([
      droppedMacro,
    ]);

    const { snapshots } = await reader.snapshotActivity();
    expect(snapshots).toHaveLength(HISTORY_LATEST_SNAPSHOT + 1);
    expect(snapshots.every(({ author, commitMessage }) => author === null && commitMessage === null)).toBe(
      true,
    );
    expect(snapshots.find(({ id }) => id === HISTORY_SNAPSHOT.createGrossMacro)?.changes).toEqual([
      createdMacro,
    ]);
    expect(snapshots.find(({ id }) => id === HISTORY_SNAPSHOT.dropLegacyFeeMacro)?.changes).toEqual([
      droppedMacro,
    ]);

    // A limit still says that there are older snapshots after the fallback without commit columns.
    const page = await reader.snapshotActivity(5);
    expect(page.snapshots.map(({ id }) => id)).toEqual([56, 55, 54, 53, 52]);
    expect(page.more).toBe(true);
    expect((await reader.snapshotActivity(HISTORY_LATEST_SNAPSHOT + 1)).more).toBe(false);
  });

  describe('of a catalog after snapshots expired', () => {
    let reader: CatalogReader;
    beforeAll(async () => {
      reader = await catalogWith('expired.sqlite', historyFixture.expired);
    });

    it('lists and counts only the snapshots that are left, each with its own changes', async () => {
      expect((await reader.snapshots()).map(({ id }) => id)).toEqual([...EXPIRED_SNAPSHOTS].reverse());
      const properties = await reader.properties();
      expect(properties.snapshotCount).toBe(EXPIRED_SNAPSHOTS.length);
      expect(properties.firstSnapshotTime).toBe((await reader.snapshots()).at(-1)?.time);

      const { snapshots, more } = await reader.snapshotActivity();
      expect(more).toBe(false);
      expect(snapshots.map(({ id, changes }) => [id, changes.map(({ raw }) => raw)])).toEqual([
        [56, ['inserted_into_table:19']],
        [55, ['merge_adjacent:19']],
        [0, ['created_schema:"main"']],
      ]);
    });

    it('keeps what the record of changes keeps and drops what expiry removed with the rows', async () => {
      // No lifetime for a dropped table whose rows expiry removed; the one of a table that lives on stays.
      await expect(reader.lifetime('table', HISTORY_ID.oldStuff)).resolves.toBeUndefined();
      await expect(reader.lifetime('table', log)).resolves.toEqual({
        begin: HISTORY_SNAPSHOT.createLog,
        end: null,
      });
      // The changes of an expired snapshot stay; shop.old_stuff ended before the oldest snapshot that is left, so it
      // keeps its id and loses its name.
      await expect(reader.snapshotChanges(HISTORY_SNAPSHOT.updateCustomer)).resolves.toEqual([
        change('inserted_into_table:9', 'inserted', 'table', customers, 'shop', 'customers'),
        change('deleted_from_table:9', 'deleted', 'table', customers, 'shop', 'customers'),
      ]);
      await expect(reader.snapshotChanges(HISTORY_SNAPSHOT.dropOldStuff)).resolves.toEqual([
        change('dropped_table:15', 'dropped', 'table', HISTORY_ID.oldStuff, null, null),
      ]);
      // The files that wait for deletion include the one of the dropped table.
      const { scheduledForDeletion } = await reader.storage(HISTORY_LATEST_SNAPSHOT);
      expect(scheduledForDeletion.count).toBe(EXPIRED_SCHEDULED_FOR_DELETION.length);
    });
  });

  it('answers the new questions of a catalog written for specification 1.0 like a 1.1 catalog', async () => {
    const previous = await catalogWith('v1.sqlite', FIXTURE_V1_0);
    const properties = await previous.properties();
    expect(properties).toMatchObject({
      specVersion: '1.0',
      encrypted: false,
      dataPath: '/tmp/aantje-fixture-data/',
      snapshotCount: FIXTURE_LATEST + 1,
    });
    expect(properties.metadata.map(({ key }) => key)).toEqual([
      'created_by',
      'data_path',
      'encrypted',
      'version',
    ]);
    await expect(previous.partitioning(FIXTURE_ID.orders, FIXTURE_LATEST)).resolves.toBeUndefined();
    await expect(previous.sortOrder(FIXTURE_ID.orders, FIXTURE_LATEST)).resolves.toBeUndefined();
    await expect(previous.macros(FIXTURE_ID.salesSchema, FIXTURE_LATEST)).resolves.toEqual([]);
    await expect(previous.tags(FIXTURE_ID.orders, FIXTURE_LATEST)).resolves.toEqual({
      table: [],
      columns: [],
    });
    expect((await previous.snapshots()).every(({ author }) => author === null)).toBe(true);

    // The activity of every snapshot reads like the changes of that snapshot, and a dropped table is named.
    const { snapshots, more } = await previous.snapshotActivity();
    expect(more).toBe(false);
    expect(snapshots).toHaveLength(FIXTURE_LATEST + 1);
    expect(snapshots.every(({ author, commitMessage }) => author === null && commitMessage === null)).toBe(
      true,
    );
    for (const snapshot of snapshots) {
      expect(snapshot.changes, `changes of @${snapshot.id}`).toEqual(
        await previous.snapshotChanges(snapshot.id),
      );
    }
    await expect(previous.snapshotChanges(11)).resolves.toEqual([
      change('dropped_table:3', 'dropped', 'table', FIXTURE_ID.tmp, 'sales', 'tmp'),
    ]);
  });
});
