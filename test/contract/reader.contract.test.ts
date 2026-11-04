import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver } from '../../src/catalog/drivers/driver';
import { openDuckdb } from '../../src/catalog/drivers/duckdb';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader, ColumnInfo, TableInfo } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { BIG_ORDERS_VIEW_SQL, ID, LATEST_SNAPSHOT, SNAPSHOT, SPEC_VERSION, STATS } from '../support/expected';
import { fixturePath, wasmPath } from '../support/fixtures';
import { catalogSources } from '../support/sources';
import { duckdbSource } from '../support/sources/duckdb';

/** Same statements as the main fixture, written by DuckDB 1.5 (DuckLake specification 1.0). */
const FIXTURE_V1_0 = fileURLToPath(new URL('../fixtures/ducklake-1.0.sqlite', import.meta.url));

const CHANGES = [
  'created_schema:"main"',
  'created_schema:"sales"',
  'created_table:"sales"."orders"',
  'created_table:"sales"."tmp"',
  'inserted_into_table:2',
  'inserted_into_table:3',
  'deleted_from_table:2',
  'created_view:"sales"."big_orders"',
  'altered_table:2',
  'altered_table:2',
  'altered_view:4',
  'dropped_table:3',
  'created_table:"main"."plain"',
  'altered_table:5',
];

function column(id: number, name: string, type: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return { id, name, type, nullable: true, defaultValue: null, comment: null, children: [], ...extra };
}

/** The columns of sales.orders; `amount` carries its comment from snapshot 9 on. */
function ordersColumns(amountComment: string | null): ColumnInfo[] {
  return [
    column(1, 'id', 'int32', { nullable: false }),
    column(2, 'customer', 'struct', {
      children: [
        column(3, 'name', 'varchar'),
        column(4, 'tags', 'list', { children: [column(5, 'element', 'varchar')] }),
      ],
    }),
    column(6, 'attrs', 'map', { children: [column(7, 'key', 'varchar'), column(8, 'value', 'int32')] }),
    column(9, 'amount', 'decimal(10,2)', { defaultValue: '0', comment: amountComment }),
    column(10, 'created', 'timestamp'),
  ];
}

function table(
  id: number,
  schemaId: number,
  name: string,
  comment: string | null,
  stats: TableInfo['stats'],
) {
  return { id, schemaId, name, comment, stats };
}

const NO_FILES = { ...STATS.beforeFirstInsert, sizeBytes: 0 };

for (const source of catalogSources) {
  const skipReason = source.skipReason();
  describe.skipIf(skipReason !== undefined)(
    `catalog reader on ${source.name}${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`,
    () => {
      let driver: Driver;
      let reader: CatalogReader;
      /** Byte sizes of the data and delete files, read from the raw tables because they differ per variant. */
      let ordersDataBytes: number;
      let ordersDeleteBytes: number;
      let tmpDataBytes: number;

      async function fileBytes(sql: string, tableId: number): Promise<number> {
        const rows = await driver.query(sql, [tableId]);
        expect(rows).toHaveLength(1);
        return Number(rows[0]?.file_size_bytes);
      }

      beforeAll(async () => {
        driver = await source.open();
        reader = createCatalogReader(driver);
        ordersDataBytes = await fileBytes(
          'SELECT file_size_bytes FROM ducklake_data_file WHERE table_id = ?',
          ID.orders,
        );
        ordersDeleteBytes = await fileBytes(
          'SELECT file_size_bytes FROM ducklake_delete_file WHERE table_id = ?',
          ID.orders,
        );
        tmpDataBytes = await fileBytes(
          'SELECT file_size_bytes FROM ducklake_data_file WHERE table_id = ?',
          ID.tmp,
        );
      });
      afterAll(() => reader.close());

      it('reports the version, lists every snapshot newest first with its changes and UTC time, and the schemas that existed at a snapshot', async () => {
        await expect(reader.info()).resolves.toEqual({
          specVersion: SPEC_VERSION,
          latestSnapshot: LATEST_SNAPSHOT,
        });
        const snapshots = await reader.snapshots();
        const listed = snapshots.map(({ id, changes }) => ({ id, changes }));
        expect(listed).toEqual(CHANGES.map((changes, id) => ({ id, changes })).reverse());

        const newest = await reader.snapshots(3);
        expect(newest.map(({ id, changes }) => ({ id, changes }))).toEqual(listed.slice(0, 3));
        expect(await reader.snapshots(1000)).toEqual(snapshots);

        for (const { time } of snapshots) {
          expect(time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        }
        const times = snapshots.map(({ time }) => time);
        expect([...times].sort().reverse()).toEqual(times);
        // The stored value is UTC in every variant, so the date and time down to the second must be the same.
        const stored = await driver.query(
          'SELECT snapshot_time FROM ducklake_snapshot WHERE snapshot_id = ?',
          [SNAPSHOT.createSalesSchema],
        );
        const first = snapshots.find(({ id }) => id === SNAPSHOT.createSalesSchema);
        expect(first?.time.slice(0, 19)).toBe(
          String(stored[0]?.snapshot_time).replace(' ', 'T').slice(0, 19),
        );
        await expect(reader.schemas(LATEST_SNAPSHOT)).resolves.toEqual([
          { id: ID.mainSchema, name: 'main', comment: null },
          { id: ID.salesSchema, name: 'sales', comment: null },
        ]);
        await expect(reader.schemas(SNAPSHOT.createMainSchema)).resolves.toEqual([
          { id: ID.mainSchema, name: 'main', comment: null },
        ]);
        await expect(reader.schemas(SNAPSHOT.createSalesSchema)).resolves.toHaveLength(2);
      });

      it('follows the tables of a schema through creation, inserts, a delete and a drop with exact rows, files and bytes, their comments and the views', async () => {
        await expect(reader.tables(ID.salesSchema, SNAPSHOT.createOrders - 1)).resolves.toEqual([]);
        await expect(reader.tables(ID.salesSchema, SNAPSHOT.createOrders)).resolves.toEqual([
          table(ID.orders, ID.salesSchema, 'orders', null, NO_FILES),
        ]);
        await expect(reader.tables(ID.salesSchema, SNAPSHOT.createTmp)).resolves.toEqual([
          table(ID.orders, ID.salesSchema, 'orders', null, NO_FILES),
          table(ID.tmp, ID.salesSchema, 'tmp', null, NO_FILES),
        ]);

        const ordersInserted = table(ID.orders, ID.salesSchema, 'orders', null, {
          ...STATS.ordersAfterInsert,
          sizeBytes: ordersDataBytes,
        });
        await expect(reader.tables(ID.salesSchema, SNAPSHOT.insertOrders)).resolves.toEqual([
          ordersInserted,
          table(ID.tmp, ID.salesSchema, 'tmp', null, NO_FILES),
        ]);
        await expect(reader.tables(ID.salesSchema, SNAPSHOT.insertTmp)).resolves.toEqual([
          ordersInserted,
          table(ID.tmp, ID.salesSchema, 'tmp', null, { ...STATS.tmpAfterInsert, sizeBytes: tmpDataBytes }),
        ]);

        // The delete subtracts its rows and adds the delete file to the size from its own snapshot on.
        const afterDelete = table(ID.orders, ID.salesSchema, 'orders', null, {
          ...STATS.ordersAfterDelete,
          sizeBytes: ordersDataBytes + ordersDeleteBytes,
        });
        const [orders, tmp] = await reader.tables(ID.salesSchema, SNAPSHOT.deleteOrder2);
        expect(orders).toEqual(afterDelete);
        expect(tmp?.stats).toEqual({ ...STATS.tmpAfterInsert, sizeBytes: tmpDataBytes });

        // The dropped table and its files are gone from the snapshot of the drop on.
        const lastWithTmp = await reader.tables(ID.salesSchema, SNAPSHOT.dropTmp - 1);
        expect(lastWithTmp.map(({ name }) => name)).toEqual(['orders', 'tmp']);
        expect(lastWithTmp[1]?.stats).toEqual({ ...STATS.tmpAfterInsert, sizeBytes: tmpDataBytes });
        const afterDrop = { ...afterDelete, comment: 'Customer orders' };
        await expect(reader.tables(ID.salesSchema, SNAPSHOT.dropTmp)).resolves.toEqual([afterDrop]);
        await expect(reader.tables(ID.salesSchema, LATEST_SNAPSHOT)).resolves.toEqual([afterDrop]);
        const comments = async (snapshot: number) =>
          (await reader.tables(ID.salesSchema, snapshot)).map(({ name, comment }) => ({ name, comment }));
        await expect(comments(SNAPSHOT.createBigOrdersView)).resolves.toEqual([
          { name: 'orders', comment: null },
          { name: 'tmp', comment: null },
        ]);
        await expect(comments(SNAPSHOT.commentOnOrders)).resolves.toEqual([
          { name: 'orders', comment: 'Customer orders' },
          { name: 'tmp', comment: null },
        ]);

        await expect(reader.tables(ID.mainSchema, SNAPSHOT.createPlain - 1)).resolves.toEqual([]);
        await expect(reader.tables(ID.mainSchema, SNAPSHOT.createPlain)).resolves.toEqual([
          table(ID.plain, ID.mainSchema, 'plain', null, NO_FILES),
        ]);
        await expect(reader.tables(ID.mainSchema, LATEST_SNAPSHOT)).resolves.toEqual([
          table(ID.plain, ID.mainSchema, 'plain', null, NO_FILES),
        ]);
        await expect(reader.views(ID.salesSchema, SNAPSHOT.deleteOrder2)).resolves.toEqual([]);
        await expect(reader.views(ID.salesSchema, SNAPSHOT.createBigOrdersView)).resolves.toEqual([
          {
            id: ID.bigOrdersView,
            schemaId: ID.salesSchema,
            name: 'big_orders',
            comment: null,
            sql: BIG_ORDERS_VIEW_SQL,
            dialect: 'duckdb',
            columnAliases: [],
          },
        ]);
        const comment = async (snapshot: number) =>
          (await reader.views(ID.salesSchema, snapshot))[0]?.comment;
        await expect(comment(SNAPSHOT.commentOnAmount)).resolves.toBeNull();
        await expect(comment(SNAPSHOT.commentOnView)).resolves.toBe('Orders above 1');
        await expect(comment(LATEST_SNAPSHOT)).resolves.toBe('Orders above 1');
        await expect(reader.views(ID.mainSchema, LATEST_SNAPSHOT)).resolves.toEqual([]);
      });

      it('returns the nested columns with their comment from the snapshot that set it, none outside a table lifetime, and the entries by schema and name', async () => {
        await expect(reader.columns(ID.orders, SNAPSHOT.commentOnOrders)).resolves.toEqual(
          ordersColumns(null),
        );
        await expect(reader.columns(ID.orders, SNAPSHOT.commentOnAmount)).resolves.toEqual(
          ordersColumns('Net amount in EUR'),
        );
        await expect(reader.columns(ID.orders, LATEST_SNAPSHOT)).resolves.toEqual(
          ordersColumns('Net amount in EUR'),
        );
        await expect(reader.columns(ID.orders, SNAPSHOT.createSalesSchema)).resolves.toEqual([]);
        await expect(reader.columns(ID.tmp, SNAPSHOT.dropTmp - 1)).resolves.toEqual([
          column(1, 'a', 'int32'),
        ]);
        await expect(reader.columns(ID.tmp, SNAPSHOT.dropTmp)).resolves.toEqual([]);

        await expect(reader.columns(ID.plain, SNAPSHOT.createPlain)).resolves.toEqual([
          column(1, 'x', 'int64'),
          column(2, 'y', 'varchar'),
        ]);
        await expect(reader.columns(ID.plain, SNAPSHOT.addPlainColumn)).resolves.toEqual([
          column(1, 'x', 'int64'),
          column(2, 'y', 'varchar'),
          column(3, 'z', 'float64'),
        ]);
        await expect(reader.entries(LATEST_SNAPSHOT)).resolves.toEqual([
          { kind: 'table', id: ID.plain, name: 'plain', schemaId: ID.mainSchema, schemaName: 'main' },
          {
            kind: 'view',
            id: ID.bigOrdersView,
            name: 'big_orders',
            schemaId: ID.salesSchema,
            schemaName: 'sales',
          },
          { kind: 'table', id: ID.orders, name: 'orders', schemaId: ID.salesSchema, schemaName: 'sales' },
        ]);
        await expect(reader.entries(SNAPSHOT.createMainSchema)).resolves.toEqual([]);
        await expect(reader.entries(SNAPSHOT.deleteOrder2)).resolves.toEqual([
          { kind: 'table', id: ID.orders, name: 'orders', schemaId: ID.salesSchema, schemaName: 'sales' },
          { kind: 'table', id: ID.tmp, name: 'tmp', schemaId: ID.salesSchema, schemaName: 'sales' },
        ]);
      });
    },
  );
}

describe('catalog reader on a catalog written for DuckLake specification 1.0', () => {
  let current: CatalogReader;
  let previous: CatalogReader;
  beforeAll(async () => {
    current = createCatalogReader(await openSqlite({ path: fixturePath('ducklake.sqlite'), wasmPath }));
    previous = createCatalogReader(await openSqlite({ path: FIXTURE_V1_0, wasmPath }));
  });
  afterAll(async () => {
    await current.close();
    await previous.close();
  });

  /** File sizes differ between the two generated catalogs; everything else is identical. */
  async function catalogAt(reader: CatalogReader, snapshot: number) {
    const schemas = await reader.schemas(snapshot);
    return {
      schemas,
      tables: await Promise.all(
        schemas.map(async ({ id }) =>
          (await reader.tables(id, snapshot)).map(({ stats, ...rest }) => ({
            ...rest,
            rows: stats.rows,
            files: stats.files,
          })),
        ),
      ),
      views: await Promise.all(schemas.map(({ id }) => reader.views(id, snapshot))),
      columns: await Promise.all([ID.orders, ID.tmp, ID.plain].map((id) => reader.columns(id, snapshot))),
      entries: await reader.entries(snapshot),
    };
  }

  // Tables and views visible at each snapshot 0..13; anchors the comparison, which a stub reader would pass.
  const ENTRY_COUNT = [0, 0, 1, 2, 2, 2, 2, 3, 3, 3, 3, 2, 3, 3];

  it('is recognised as 1.0 and returns the same snapshots, schemas, tables, views, columns, comments, entries and statistics as the 1.1 catalog', async () => {
    await expect(previous.info()).resolves.toEqual({ specVersion: '1.0', latestSnapshot: LATEST_SNAPSHOT });
    const ids = async (reader: CatalogReader) =>
      (await reader.snapshots()).map(({ id, changes }) => ({ id, changes }));
    await expect(ids(previous)).resolves.toEqual(await ids(current));

    for (let snapshot = 0; snapshot <= LATEST_SNAPSHOT; snapshot++) {
      expect((await previous.entries(snapshot)).length, `entries at ${snapshot}`).toBe(ENTRY_COUNT[snapshot]);
      expect(await catalogAt(previous, snapshot), `catalog at ${snapshot}`).toEqual(
        await catalogAt(current, snapshot),
      );
    }

    const [orders] = await previous.tables(ID.salesSchema, LATEST_SNAPSHOT);
    expect(orders?.stats).toMatchObject(STATS.ordersAfterDelete);
    expect(orders?.stats.sizeBytes).toBeGreaterThan(0);
  });
});

/** SQLite catalogs that are edited with sql.js, for the cases the generated fixtures cannot show. */
describe('catalog reader on edited copies of the SQLite fixture', () => {
  let dir: string;
  const opened: Driver[] = [];
  /** Byte sizes of the data file and the delete file of sales.orders in the fixture; some tests add files to them. */
  let ordersDataBytes: number;
  let ordersDeleteBytes: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aantje-reader-'));
    const driver = await openSqlite({ path: fixturePath('ducklake.sqlite'), wasmPath });
    try {
      const bytes = async (table: 'ducklake_data_file' | 'ducklake_delete_file') =>
        Number(
          (await driver.query(`SELECT file_size_bytes FROM ${table} WHERE table_id = ?`, [ID.orders]))[0]
            ?.file_size_bytes,
        );
      ordersDataBytes = await bytes('ducklake_data_file');
      ordersDeleteBytes = await bytes('ducklake_delete_file');
    } finally {
      await driver.close();
    }
  });
  afterAll(async () => {
    await Promise.all(opened.map((driver) => driver.close()));
    rmSync(dir, { recursive: true, force: true });
  });

  /** Writes a SQLite file (a copy of the fixture when `fromFixture`) after applying `statements` to it. */
  async function catalogWith(
    name: string,
    fromFixture: boolean,
    ...statements: string[]
  ): Promise<CatalogReader> {
    const wasm = readFileSync(wasmPath);
    const SQL = await initSqlJs({
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    });
    const db = new SQL.Database(fromFixture ? readFileSync(fixturePath('ducklake.sqlite')) : undefined);
    for (const statement of statements) {
      db.run(statement);
    }
    const path = join(dir, name);
    writeFileSync(path, db.export());
    db.close();
    const driver = await openSqlite({ path, wasmPath });
    opened.push(driver);
    return createCatalogReader(driver);
  }

  const fixtureWith = (name: string, ...statements: string[]) => catalogWith(name, true, ...statements);

  describe('that are not a supported DuckLake catalog', () => {
    it('rejects a database without ducklake tables as NOT_A_DUCKLAKE, and any 1.x version but not another one', async () => {
      const other = await catalogWith(
        'other.sqlite',
        false,
        'CREATE TABLE customers (id INTEGER, name TEXT)',
      );
      await expect(other.info()).rejects.toMatchObject({ code: 'NOT_A_DUCKLAKE' });

      const empty = await catalogWith(
        'empty.sqlite',
        false,
        'CREATE TABLE ducklake_metadata ("key" VARCHAR, "value" VARCHAR, scope VARCHAR, scope_id BIGINT)',
        'CREATE TABLE ducklake_snapshot (snapshot_id BIGINT PRIMARY KEY)',
      );
      await expect(empty.info()).rejects.toMatchObject({ code: 'NOT_A_DUCKLAKE' });
      const withVersion = (version: string) =>
        fixtureWith(
          `version-${version.replaceAll(/[^0-9a-z.]/gi, '_')}.sqlite`,
          `UPDATE ducklake_metadata SET value = '${version}' WHERE key = 'version'`,
        );
      for (const version of ['1.0', '1.7', '1.10', '1.25']) {
        await expect((await withVersion(version)).info(), version).resolves.toEqual({
          specVersion: version,
          latestSnapshot: LATEST_SNAPSHOT,
        });
      }
      // Look-alikes of 1.x: '11.0' and '21.5' contain "1.", '1' and '1.' have no minor version, '1.x' a non-numeric one.
      for (const version of ['0.3', '2.0', '11.0', '21.5', '1', '1.', '1.x']) {
        await expect((await withVersion(version)).info(), version).rejects.toMatchObject({
          code: 'UNSUPPORTED_VERSION',
          userMessage: expect.stringContaining(`"${version}"`) as unknown,
        });
      }
      // Text after the number would reach the tooltip as Markdown.
      await expect((await withVersion('1.1 [x](https://e.example)')).info()).rejects.toMatchObject({
        code: 'UNSUPPORTED_VERSION',
      });
    });
  });

  describe('with data the generated fixtures do not contain', () => {
    /** A data file of sales.orders; the reader only looks at the table, the snapshots, the rows and the size. */
    const dataFile = (id: number, beginSnapshot: number, rows: number, bytes: number) =>
      `INSERT INTO ducklake_data_file (data_file_id, table_id, begin_snapshot, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, row_group_count) VALUES (${id}, ${ID.orders}, ${beginSnapshot}, 'file-${id}.parquet', 1, 'parquet', ${rows}, ${bytes}, 50, 0, 1)`;

    const ordersStats = async (reader: CatalogReader, snapshot: number) =>
      (await reader.tables(ID.salesSchema, snapshot)).find(({ id }) => id === ID.orders)?.stats;

    it('reads columns in column_order with their defaults, snapshots without a changes row, and the fields and dialect of a view', async () => {
      const columnsReader = await fixtureWith(
        'columns.sqlite',
        "UPDATE ducklake_column SET column_order = CASE column_name WHEN 'x' THEN 3 WHEN 'y' THEN 1 ELSE 2 END WHERE table_id = 5",
        "UPDATE ducklake_column SET default_value = '-7' WHERE table_id = 5 AND column_id = 1",
        "UPDATE ducklake_column SET default_value = 'n/a' WHERE table_id = 5 AND column_id = 2",
        "UPDATE ducklake_column SET default_value = '1.5' WHERE table_id = 5 AND column_id = 3",
        "UPDATE ducklake_column SET default_value = 'now()', default_value_type = 'expression' WHERE table_id = 2 AND column_id = 10",
      );
      const columns = await columnsReader.columns(ID.plain, LATEST_SNAPSHOT);
      expect(columns.map(({ id, name, defaultValue }) => ({ id, name, defaultValue }))).toEqual([
        { id: 2, name: 'y', defaultValue: "'n/a'" },
        { id: 3, name: 'z', defaultValue: '1.5' },
        { id: 1, name: 'x', defaultValue: '-7' },
      ]);
      expect(
        (await columnsReader.columns(ID.orders, LATEST_SNAPSHOT)).find((c) => c.name === 'created')
          ?.defaultValue,
      ).toBe('now()');

      // A snapshot without a changes row has changes null; the highest id is the latest when old snapshots expired.
      const snapshotsReader = await fixtureWith(
        'snapshots.sqlite',
        'DELETE FROM ducklake_snapshot_changes WHERE snapshot_id = 5',
        'DELETE FROM ducklake_snapshot WHERE snapshot_id < 4',
      );
      await expect(snapshotsReader.info()).resolves.toEqual({
        specVersion: '1.1',
        latestSnapshot: LATEST_SNAPSHOT,
      });
      const snapshots = await snapshotsReader.snapshots();
      expect(snapshots.map(({ id }) => id)).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
      expect(snapshots.find(({ id }) => id === 5)?.changes).toBeNull();
      expect(snapshots.find(({ id }) => id === 4)?.changes).toBe('inserted_into_table:2');

      // The explicit column names of a view, with commas and quotes, and the dialect it was written in.
      const viewReader = await fixtureWith(
        'view-fields.sqlite',
        `UPDATE ducklake_view SET column_aliases = '"order,id","total ""net"""', dialect = 'spark' WHERE view_id = ${ID.bigOrdersView}`,
      );
      const [view] = await viewReader.views(ID.salesSchema, LATEST_SNAPSHOT);
      expect(view?.columnAliases).toEqual(['order,id', 'total "net"']);
      expect(view?.dialect).toBe('spark');
    });

    it('shows comments exactly from the snapshot of the change, to the right table and column, and ignores tags that are not comments', async () => {
      const commentsReader = await fixtureWith(
        'comments.sqlite',
        `INSERT INTO ducklake_tag VALUES (${ID.salesSchema}, 5, NULL, 'comment', 'Sales data')`,
        `UPDATE ducklake_tag SET end_snapshot = 12 WHERE object_id = ${ID.orders}`,
        `INSERT INTO ducklake_tag VALUES (${ID.orders}, 12, NULL, 'comment', 'All orders')`,
        `UPDATE ducklake_column_tag SET end_snapshot = 12 WHERE table_id = ${ID.orders}`,
        `INSERT INTO ducklake_column_tag VALUES (${ID.orders}, 9, 12, NULL, 'comment', 'Gross amount')`,
      );
      const sales = async (snapshot: number) =>
        (await commentsReader.schemas(snapshot)).find(({ id }) => id === ID.salesSchema)?.comment;
      await expect(sales(4)).resolves.toBeNull();
      await expect(sales(5)).resolves.toBe('Sales data');
      await expect(sales(LATEST_SNAPSHOT)).resolves.toBe('Sales data');

      const comments = async (snapshot: number) => ({
        table: (await commentsReader.tables(ID.salesSchema, snapshot))[0]?.comment,
        amount: (await commentsReader.columns(ID.orders, snapshot)).find(({ name }) => name === 'amount')
          ?.comment,
      });
      await expect(comments(11)).resolves.toEqual({ table: 'Customer orders', amount: 'Net amount in EUR' });
      await expect(comments(12)).resolves.toEqual({ table: 'All orders', amount: 'Gross amount' });

      // column_id is only unique per table: column 1 is orders.id and plain.x.
      const tagsReader = await fixtureWith(
        'tags.sqlite',
        `INSERT INTO ducklake_column_tag VALUES (${ID.plain}, 1, 12, NULL, 'comment', 'The x of plain')`,
        `INSERT INTO ducklake_tag VALUES (${ID.orders}, 8, NULL, 'owner', 'team-a')`,
        `INSERT INTO ducklake_column_tag VALUES (${ID.orders}, 9, 9, NULL, 'unit', 'EUR')`,
      );
      const first = async (tableId: number) => (await tagsReader.columns(tableId, LATEST_SNAPSHOT))[0];
      expect(await first(ID.plain)).toMatchObject({ name: 'x', comment: 'The x of plain' });
      expect(await first(ID.orders)).toMatchObject({ name: 'id', comment: null });

      const tables = await tagsReader.tables(ID.salesSchema, LATEST_SNAPSHOT);
      expect(tables.map(({ name, comment }) => ({ name, comment }))).toEqual([
        { name: 'orders', comment: 'Customer orders' },
      ]);
      const columns = await tagsReader.columns(ID.orders, LATEST_SNAPSHOT);
      expect(columns.map(({ name }) => name)).toEqual(['id', 'customer', 'attrs', 'amount', 'created']);
      expect(columns.find(({ name }) => name === 'amount')?.comment).toBe('Net amount in EUR');
    });

    it('sorts by name, not by id, and shows one version of a renamed table or a replaced view at every snapshot', async () => {
      const namesReader = await fixtureWith(
        'names.sqlite',
        "UPDATE ducklake_schema SET schema_name = 'zz' WHERE schema_id = 0",
        "UPDATE ducklake_table SET table_name = 'a_tmp' WHERE table_id = 3",
        "INSERT INTO ducklake_view VALUES (9, 'a-view-uuid', 7, NULL, 1, 'a_view', 'duckdb', 'SELECT 1', '')",
      );
      const names = (items: readonly { name: string }[]) => items.map(({ name }) => name);

      expect(names(await namesReader.schemas(LATEST_SNAPSHOT))).toEqual(['sales', 'zz']);
      expect(names(await namesReader.tables(ID.salesSchema, SNAPSHOT.commentOnView))).toEqual([
        'a_tmp',
        'orders',
      ]);
      expect(names(await namesReader.views(ID.salesSchema, LATEST_SNAPSHOT))).toEqual([
        'a_view',
        'big_orders',
      ]);
      const sorted = await namesReader.entries(SNAPSHOT.commentOnView);
      expect(sorted.map(({ kind, schemaName, name }) => `${schemaName}.${name} (${kind})`)).toEqual([
        'sales.a_tmp (table)',
        'sales.a_view (view)',
        'sales.big_orders (view)',
        'sales.orders (table)',
      ]);

      // How DuckLake records ALTER TABLE ... RENAME and CREATE OR REPLACE VIEW: the old row ends, a new row with the same id begins.
      const renamedReader = await fixtureWith(
        'renamed.sqlite',
        `UPDATE ducklake_table SET end_snapshot = 9 WHERE table_id = ${ID.orders}`,
        `INSERT INTO ducklake_table VALUES (${ID.orders}, 'renamed-uuid', 9, NULL, ${ID.salesSchema}, 'orders_v2', 'orders/', 1)`,
        `UPDATE ducklake_view SET end_snapshot = 12 WHERE view_id = ${ID.bigOrdersView}`,
        `INSERT INTO ducklake_view VALUES (${ID.bigOrdersView}, 'replaced-view-uuid', 12, NULL, ${ID.salesSchema}, 'big_orders', 'duckdb', 'SELECT 1 AS id', '')`,
      );
      const orders = async (snapshot: number) =>
        (await renamedReader.tables(ID.salesSchema, snapshot)).filter(({ id }) => id === ID.orders);
      const before = await orders(8);
      const after = await orders(9);
      expect(before.map(({ name }) => name)).toEqual(['orders']);
      expect(after.map(({ name }) => name)).toEqual(['orders_v2']);
      expect(after[0]?.stats).toEqual(before[0]?.stats);
      expect(after[0]?.stats).toMatchObject(STATS.ordersAfterDelete);

      const sql = async (snapshot: number) =>
        (await renamedReader.views(ID.salesSchema, snapshot)).map((view) => view.sql);
      await expect(sql(11)).resolves.toEqual([BIG_ORDERS_VIEW_SQL]);
      await expect(sql(12)).resolves.toEqual(['SELECT 1 AS id']);
      const entries = await renamedReader.entries(LATEST_SNAPSHOT);
      expect(entries.filter(({ id }) => id === ID.orders).map(({ name }) => name)).toEqual(['orders_v2']);
      expect(entries.filter(({ kind }) => kind === 'view')).toHaveLength(1);
      expect((await renamedReader.entries(11)).filter(({ kind }) => kind === 'view')).toHaveLength(1);
    });

    it('adds up the data files of a table, takes a delete file only from its own data file, and counts only the files in force after a compaction, a second delete or a full delete', async () => {
      // A second INSERT into orders at snapshot 5 adds a second data file with 4 rows.
      const twoFiles = await fixtureWith('two-files.sqlite', dataFile(7, 5, 4, 500));

      await expect(ordersStats(twoFiles, 4)).resolves.toEqual({
        rows: 3,
        files: 1,
        sizeBytes: ordersDataBytes,
      });
      await expect(ordersStats(twoFiles, 5)).resolves.toEqual({
        rows: 3 + 4,
        files: 2,
        sizeBytes: ordersDataBytes + 500,
      });
      // From snapshot 6 the delete file removes one row of the first data file; the second one keeps all its rows.
      await expect(ordersStats(twoFiles, LATEST_SNAPSHOT)).resolves.toEqual({
        rows: 3 - 1 + 4,
        files: 2,
        sizeBytes: ordersDataBytes + ordersDeleteBytes + 500,
      });

      const before = { rows: 2, files: 1, sizeBytes: ordersDataBytes + ordersDeleteBytes };

      // Snapshot 9 rewrites the data file and its delete file into one file that holds the 2 live rows.
      const compacted = await fixtureWith(
        'compacted.sqlite',
        `UPDATE ducklake_data_file SET end_snapshot = 9 WHERE table_id = ${ID.orders}`,
        `UPDATE ducklake_delete_file SET end_snapshot = 9 WHERE table_id = ${ID.orders}`,
        dataFile(7, 9, 2, 2000),
      );
      await expect(ordersStats(compacted, 8)).resolves.toEqual(before);
      await expect(ordersStats(compacted, 9)).resolves.toEqual({ rows: 2, files: 1, sizeBytes: 2000 });

      // The second DELETE ends the delete file of snapshot 6 and writes a new one that holds both deleted rows.
      const redeleted = await fixtureWith(
        'redeleted.sqlite',
        `UPDATE ducklake_delete_file SET end_snapshot = 9 WHERE table_id = ${ID.orders}`,
        `INSERT INTO ducklake_delete_file (delete_file_id, table_id, begin_snapshot, data_file_id, path, path_is_relative, format, delete_count, file_size_bytes, footer_size, row_group_count) VALUES (8, ${ID.orders}, 9, 0, 'delete2.parquet', 1, 'parquet', 2, 900, 100, 1)`,
      );
      await expect(ordersStats(redeleted, 8)).resolves.toEqual(before);
      await expect(ordersStats(redeleted, 9)).resolves.toEqual({
        rows: 1,
        files: 1,
        sizeBytes: ordersDataBytes + 900,
      });

      // A full DELETE or a compaction ends the data file in snapshot 9; the table stays.
      const emptied = await fixtureWith(
        'emptied.sqlite',
        `UPDATE ducklake_data_file SET end_snapshot = 9 WHERE table_id = ${ID.orders}`,
      );
      await expect(ordersStats(emptied, 8)).resolves.toEqual(before);
      for (const snapshot of [9, LATEST_SNAPSHOT]) {
        await expect(ordersStats(emptied, snapshot)).resolves.toEqual({ rows: 0, files: 0, sizeBytes: 0 });
      }
    });

    it('stops listing a dropped schema with its tables and views, and a dropped view, from the snapshot of the drop', async () => {
      const droppedSchema = await fixtureWith(
        'dropped-schema.sqlite',
        `UPDATE ducklake_schema SET end_snapshot = 12 WHERE schema_id = ${ID.salesSchema}`,
      );
      const schemaNames = async (snapshot: number) =>
        (await droppedSchema.schemas(snapshot)).map(({ name }) => name);
      const schemaEntries = async (snapshot: number) =>
        (await droppedSchema.entries(snapshot)).map(
          ({ kind, schemaName, name }) => `${kind}:${schemaName}.${name}`,
        );
      await expect(schemaNames(11)).resolves.toEqual(['main', 'sales']);
      await expect(schemaNames(12)).resolves.toEqual(['main']);
      await expect(schemaEntries(11)).resolves.toEqual(['view:sales.big_orders', 'table:sales.orders']);
      await expect(schemaEntries(12)).resolves.toEqual(['table:main.plain']);

      const droppedView = await fixtureWith(
        'dropped-view.sqlite',
        `UPDATE ducklake_view SET end_snapshot = 12 WHERE view_id = ${ID.bigOrdersView}`,
      );
      const views = async (snapshot: number) =>
        (await droppedView.views(ID.salesSchema, snapshot)).map(({ name }) => name);
      const viewEntries = async (snapshot: number) =>
        (await droppedView.entries(snapshot)).map(({ kind, name }) => `${kind}:${name}`);
      await expect(views(11)).resolves.toEqual(['big_orders']);
      await expect(views(12)).resolves.toEqual([]);
      await expect(viewEntries(11)).resolves.toEqual(['view:big_orders', 'table:orders']);
      await expect(viewEntries(12)).resolves.toEqual(['table:plain', 'table:orders']);
    });
  });
});

// SQLite cannot show what the BIGINT casts of the statistics are for (its integers are 64 bit), DuckDB can:
// a cast to INTEGER fails there as soon as a table holds more than 2^31 rows or bytes.
describe.skipIf(duckdbSource.skipReason() !== undefined)(
  'catalog reader on an edited copy of the DuckDB fixture',
  () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'aantje-reader-duckdb-'));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

    it('reports the statistics of a table with more than 2^31 rows and bytes', async () => {
      const path = join(dir, 'large.duckdb');
      copyFileSync(fixturePath('ducklake.duckdb'), path);
      const { DuckDBInstance } = await import('@duckdb/node-api');
      const writable = await DuckDBInstance.create(path);
      const connection = await writable.connect();
      await connection.run(
        `UPDATE ducklake_data_file SET record_count = 6000000000, file_size_bytes = 5000000000 WHERE table_id = ${ID.orders}`,
      );
      connection.closeSync();
      writable.closeSync();

      const driver = await openDuckdb({ path });
      try {
        const [deleteFile] = await driver.query(
          'SELECT file_size_bytes FROM ducklake_delete_file WHERE table_id = ?',
          [ID.orders],
        );
        const [orders] = await createCatalogReader(driver).tables(ID.salesSchema, LATEST_SNAPSHOT);
        expect(orders?.stats).toEqual({
          rows: 6_000_000_000 - 1,
          files: 1,
          sizeBytes: 5_000_000_000 + Number(deleteFile?.file_size_bytes),
        });
      } finally {
        await driver.close();
      }
    });
  },
);
