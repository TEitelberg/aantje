import { afterAll, describe, expect, it } from 'vitest';
import { readActivity } from '../../src/activity/read';
import { readSchemaHistory } from '../../src/schema-history/read';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { historyFixture } from '../support/sources/history';

const catalogs = editedCatalogs();
afterAll(() => catalogs.dispose());

/** `count` more snapshots after the 57 of the history fixture, each with a change of the column `n` of `main.evolving`. */
function moreVersions(count: number): string[] {
  const statements: string[] = [];
  for (let at = 0; at < count; at++) {
    const snapshot = 100 + at;
    statements.push(
      `INSERT INTO ducklake_snapshot VALUES (${snapshot}, '2026-11-01 00:00:00.000000+00', 99, 99, 99)`,
      `INSERT INTO ducklake_snapshot_changes VALUES (${snapshot}, 'altered_table:12', NULL, NULL, NULL)`,
      `UPDATE ducklake_column SET end_snapshot = ${snapshot} WHERE table_id = 12 AND column_id = 6 AND end_snapshot IS NULL`,
      `INSERT INTO ducklake_column VALUES (6, ${snapshot}, NULL, 12, 6, 'n_${at}', 'int64', NULL, 'NULL', 1, NULL, 'literal', 'duckdb')`,
    );
  }
  return statements;
}

describe('the documented limits of the two history reports', () => {
  it('reads the newest 100 schema versions of a table and says whether there are more', async () => {
    // [versions added to the 9 of the table, versions read, more]
    for (const [added, shown, more] of [
      [91, 100, false],
      [92, 100, true],
    ] as const) {
      const reader = await catalogs.open(historyFixture.sqlite, ...moreVersions(added));

      const data = await readSchemaHistory(reader, 'Lake', HISTORY_ID.evolving);

      // The oldest version read is the starting point and shows no change of its own.
      expect(data.snapshots, `${added} added`).toHaveLength(shown - (more ? 1 : 0));
      expect(data.more, `${added} added`).toBe(more);
      expect(data.snapshots.at(-1)?.id).toBe(100 + added - 1);
    }
  });

  it('reads the newest 500 snapshots of the catalog for the activity and says whether there are more', async () => {
    // [snapshots added to the 57 of the fixture, snapshots read, more]
    for (const [added, read, more] of [
      [443, 500, false],
      [444, 500, true],
    ] as const) {
      const statements = Array.from({ length: added }, (_, at) => [
        `INSERT INTO ducklake_snapshot VALUES (${100 + at}, '2026-11-01 00:00:00.000000+00', 99, 99, 99)`,
        `INSERT INTO ducklake_snapshot_changes VALUES (${100 + at}, 'inserted_into_table:3', NULL, NULL, NULL)`,
      ]).flat();
      const reader = await catalogs.open(historyFixture.sqlite, ...statements);

      const data = await readActivity(reader, 'Lake');

      expect(data.snapshots, `${added} added`).toHaveLength(read);
      expect(data.more, `${added} added`).toBe(more);
      expect(data.snapshots[0]?.id).toBe(100 + added - 1);
    }
  });
});
