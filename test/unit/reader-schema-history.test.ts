import { afterAll, describe, expect, it } from 'vitest';
import type { Driver } from '../../src/catalog/drivers/driver';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { createCatalogReader } from '../../src/catalog/reader';
import { AantjeError } from '../../src/errors';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID, HISTORY_SNAPSHOT } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';

const { evolving } = HISTORY_ID;
/** The snapshots of the nine versions of main.evolving in the fixture. */
const EVOLVING_SNAPSHOTS = [26, 28, 29, 30, 31, 32, 33, 34, 35];

const real = await openSqlite({ path: historyFixture.sqlite, wasmPath });
const edited = editedCatalogs();
afterAll(async () => {
  await real.close();
  await edited.dispose();
});

describe('schemaHistory', () => {
  it('reads the versions of a table with a handful of statements, not one per version or snapshot, and hands the signal to each', async () => {
    const calls: { sql: string; signal: AbortSignal | undefined }[] = [];
    const driver: Driver = {
      query: (sql, params, options) => {
        calls.push({ sql, signal: options?.signal });
        return real.query(sql, params, options);
      },
      close: () => Promise.resolve(),
    };
    const abort = new AbortController();

    const { versions } = await createCatalogReader(driver).schemaHistory(evolving, 100, abort.signal);

    expect(versions.map(({ snapshot }) => snapshot)).toEqual(EVOLVING_SNAPSHOTS);
    // The versions of the table, its columns and their comments, then the commit data of the snapshots.
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(calls.every(({ signal }) => signal === abort.signal)).toBe(true);
  });

  it('reads the versions with their times but without author and message when the catalog has no commit columns or a snapshot has no commit row', async () => {
    const withoutColumns = await edited.open(
      historyFixture.sqlite,
      'ALTER TABLE ducklake_snapshot_changes DROP COLUMN author',
      'ALTER TABLE ducklake_snapshot_changes DROP COLUMN commit_message',
    );
    const { versions } = await withoutColumns.schemaHistory(evolving);
    expect(
      versions.map(({ snapshot, author, commitMessage }) => [snapshot, author, commitMessage]).at(-1),
    ).toEqual([35, null, null]);
    expect(versions.every(({ time }) => time !== null)).toBe(true);

    const withoutRow = await edited.open(
      historyFixture.sqlite,
      'DELETE FROM ducklake_snapshot_changes WHERE snapshot_id = 29',
    );
    const { versions: gapped } = await withoutRow.schemaHistory(evolving);
    expect(gapped.map(({ snapshot }) => snapshot)).toEqual(EVOLVING_SNAPSHOTS);
    expect(gapped.every(({ time }) => time !== null)).toBe(true);
    expect(gapped.find(({ snapshot }) => snapshot === 29)).toMatchObject({
      author: null,
      commitMessage: null,
    });
  });

  it('passes a failure that is not a missing column on instead of reading without commit data', async () => {
    const failure = new AantjeError('LOCKED', 'The catalog is locked.');
    const driver: Driver = { query: () => Promise.reject(failure), close: () => Promise.resolve() };
    await expect(createCatalogReader(driver).schemaHistory(evolving)).rejects.toBe(failure);
  });

  it('carries author and message of the snapshot that set them', async () => {
    const reader = await edited.open(
      historyFixture.sqlite,
      "UPDATE ducklake_snapshot_changes SET author = 'ann', commit_message = 'Rename the column' WHERE snapshot_id = 29",
    );
    const { versions } = await reader.schemaHistory(evolving);

    expect(versions.map(({ snapshot, author, commitMessage }) => [snapshot, author, commitMessage])).toEqual(
      EVOLVING_SNAPSHOTS.map((snapshot) =>
        snapshot === 29 ? [29, 'ann', 'Rename the column'] : [snapshot, null, null],
      ),
    );
  });

  it('reads a table with hundreds of versions in the same few statements, keeps the newest at the limit, and none for a limit of zero', async () => {
    const VERSIONS = 600;
    const statements: string[] = [];
    for (let at = 0; at < VERSIONS; at++) {
      const snapshot = 100 + at;
      statements.push(
        `INSERT INTO ducklake_snapshot VALUES (${snapshot}, '2026-11-01 00:00:00.000000+00', 99, 99, 99)`,
        `INSERT INTO ducklake_snapshot_changes VALUES (${snapshot}, 'altered_table:12', NULL, NULL, NULL)`,
        `UPDATE ducklake_column SET end_snapshot = ${snapshot} WHERE table_id = 12 AND column_id = 6 AND end_snapshot IS NULL`,
        `INSERT INTO ducklake_column VALUES (6, ${snapshot}, NULL, 12, 6, 'n_${at}', 'int64', NULL, 'NULL', 1, NULL, 'literal', 'duckdb')`,
      );
    }
    const reader = await edited.open(historyFixture.sqlite, ...statements);
    const page = await reader.schemaHistory(evolving, 100);

    expect(page.more).toBe(true);
    expect(page.versions).toHaveLength(100);
    expect(page.versions.at(0)?.snapshot).toBe(100 + VERSIONS - 100);
    expect(page.versions.at(-1)?.snapshot).toBe(100 + VERSIONS - 1);
    expect(page.versions.at(-1)?.columns.map(({ name }) => name)).toEqual([
      'id',
      'title',
      'info',
      'n_599',
      'flag',
    ]);
    expect(page.versions.every(({ time }) => time !== null)).toBe(true);
    const all = await reader.schemaHistory(evolving);
    expect(all.versions).toHaveLength(9 + VERSIONS);
    expect(all.more).toBe(false);
    expect(await reader.schemaHistory(evolving, 0)).toEqual({ versions: [], more: true });
  });

  it('takes only the tag comment of a column as its comment, and ends it with the tag', async () => {
    const reader = await edited.open(
      historyFixture.sqlite,
      "INSERT INTO ducklake_column_tag VALUES (12, 2, 27, NULL, 'owner', 'ann')",
      "UPDATE ducklake_column_tag SET end_snapshot = 56 WHERE table_id = 9 AND key = 'comment'",
    );

    const { versions } = await reader.schemaHistory(evolving);
    expect(versions.map(({ snapshot }) => snapshot)).toEqual(EVOLVING_SNAPSHOTS);
    expect(versions.flatMap(({ columns }) => columns.map(({ comment }) => comment))).toEqual(
      versions.flatMap(({ columns }) => columns.map(() => null)),
    );

    const { versions: customerVersions } = await reader.schemaHistory(HISTORY_ID.customers);
    expect(customerVersions.map(({ snapshot }) => snapshot)).toEqual([
      HISTORY_SNAPSHOT.createCustomers,
      HISTORY_SNAPSHOT.commentOnTier,
      56,
    ]);
    expect(customerVersions.map(({ columns }) => columns.map(({ comment }) => comment))).toEqual([
      [null, null, null],
      [null, null, 'bronze, silver or gold'],
      [null, null, null],
    ]);
  });

  it('lists the columns in the order of the table, and by id where the order is the same', async () => {
    const reversed = await edited.open(
      historyFixture.sqlite,
      'UPDATE ducklake_column SET column_order = 100 - column_id WHERE table_id = 12 AND parent_column IS NULL',
    );
    const names = async (reader: typeof reversed) =>
      (await reader.schemaHistory(evolving)).versions.at(-1)?.columns.map(({ name }) => name);
    expect(await names(reversed)).toEqual(['flag', 'n', 'info', 'title', 'id']);

    const tied = await edited.open(
      historyFixture.sqlite,
      'UPDATE ducklake_column SET column_order = 0 WHERE table_id = 12 AND parent_column IS NULL',
    );
    expect(await names(tied)).toEqual(['id', 'title', 'info', 'n', 'flag']);
  });
});
