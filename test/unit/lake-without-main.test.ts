import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileProfile } from '../../src/connections/profile';
import { previewTable, readChanges } from '../../src/data/engine';
import type { DataAccess } from '../../src/data/types';
import { maintenanceOf } from '../../src/maintenance';
import type { CatalogTree } from '../../src/tree/model';
import type { NodeRef } from '../../src/tree/refs';
import { accessFor, engineSkipReason, extensionDirectory } from './data-support';
import { createLake } from './health-lake-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`The tests of a lake without the schema main are skipped: ${skipReason}`);
}

// DuckLake lets the schema main be dropped, and DuckDB looks `lake.snapshots()` and `lake.set_option()` up in it.
describe.skipIf(skipReason)('a lake without the schema main', () => {
  const lake = createLake('aantje-nomain-');
  const profile: FileProfile = {
    id: 'lake',
    name: 'lake',
    kind: 'duckdb',
    path: join(lake.directory, 'lake.ducklake'),
  };
  const access = (extra: Partial<DataAccess> = {}): DataAccess =>
    accessFor({ profile, directory: lake.directory, remove: () => Promise.resolve() }, extra);
  const items = { schema: 'silver', table: 'items' };

  /** Runs `work` on the lake attached by a plain DuckDB without `USE`, so that `memory` stays the default catalog. */
  async function elsewhere<T>(work: (rows: (sql: string) => Promise<unknown[][]>) => Promise<T>): Promise<T> {
    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      await connection.run('LOAD ducklake');
      await connection.run(`ATTACH 'ducklake:${profile.path.replaceAll('\\', '/')}' AS lake`);
      return await work(async (sql) => (await connection.runAndReadAll(sql)).getRowsJson());
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }

  beforeAll(async () => {
    // Snapshots: 1 the schema, 2 the table, 3 the insert, 4 the update, 5 the delete.
    await lake.stage([
      'CREATE SCHEMA silver',
      'CREATE TABLE silver.items (id INTEGER, name VARCHAR)',
      "INSERT INTO silver.items VALUES (1, 'a'), (2, 'b')",
      "UPDATE silver.items SET name = 'B' WHERE id = 2",
      'DELETE FROM silver.items WHERE id = 1',
      "CALL lake.set_option('auto_compact', false)",
      'DROP SCHEMA main',
    ]);
  });
  afterAll(lake.dispose);

  it('reads a table at an older snapshot and at the newest one, and shows its changes', async () => {
    expect((await previewTable(access({ snapshot: 3 }), items)).rows).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect((await previewTable(access(), items)).rows).toEqual([[2, 'B']]);
    expect((await readChanges(access(), items, { from: 3, to: 5 })).summary.counts).toEqual({
      insert: 0,
      update: 1,
      delete: 1,
    });
  });

  it('passes the health check, and the fix of its auto_compact finding runs from another catalog', async () => {
    const report = await lake.expectHealthy();
    const off = report.findings.find(({ id }) => id.startsWith('catalog.auto-compact-off'));

    const value = await elsewhere(async (rows) => {
      await rows(off?.fixSql ?? '');
      return (await rows(off?.inspectSql ?? '')).map(([name, , setting]) => [name, setting]);
    });
    expect(value).toEqual([['auto_compact', 'true']]);
  });

  it('runs the Set Option scripts of the lake and of a table from another catalog', async () => {
    const tree: Pick<CatalogTree, 'state'> = { state: () => ({ status: 'connected', snapshot: 'latest' }) };
    const schema = { id: 1, name: 'silver', comment: null };
    const table = {
      id: 2,
      schemaId: 1,
      name: 'items',
      comment: null,
      stats: { rows: 0, files: 0, sizeBytes: 0 },
    };
    const refs: NodeRef[] = [
      { kind: 'connection', connectionId: 'c' },
      { kind: 'table', connectionId: 'c', schema, table },
    ];
    const calls = refs.flatMap((ref) =>
      (maintenanceOf(tree, 'option', ref) ?? '')
        .split('\n')
        .filter((line) => line.startsWith('-- CALL '))
        .map((line) => line.slice(3).replaceAll('<column>', 'id')),
    );

    const scopes = await elsewhere(async (rows) => {
      for (const call of calls) await rows(call);
      return rows(
        "SELECT scope, count(*) FROM ducklake_options('lake') WHERE scope IN ('GLOBAL', 'TABLE') GROUP BY scope ORDER BY scope",
      );
    });
    expect(calls.length).toBeGreaterThan(20);
    expect(scopes.map(([scope]) => scope)).toEqual(['GLOBAL', 'TABLE']);
  });
});
