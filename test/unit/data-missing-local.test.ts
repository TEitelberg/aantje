import { cpSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { previewTable } from '../../src/data/engine';
import { AantjeError } from '../../src/errors';
import { healthRequestForError } from '../../src/health/request';
import { openSqlSession } from '../../src/sql/session';
import { accessFor, copyDataFixture, engineSkipReason } from './data-support';
import type { DataFixture } from './data-support';
import { events, only } from './sql-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Missing local file tests are skipped: ${skipReason}`);
}

const orders = { schema: 'sales', table: 'orders' };
// What the operating system answers for a file that is not there, as DuckDB quotes it.
const ANSWER =
  process.platform === 'win32' ? 'The system cannot find the file specified' : 'No such file or directory';

async function failure(promise: Promise<unknown>): Promise<AantjeError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AantjeError);
  return error as AantjeError;
}

describe.skipIf(skipReason)('a catalog that lists Parquet files that are not on the local disk', () => {
  let fixture: DataFixture;
  let folder: string;
  let backup: string;
  let path: string;

  beforeAll(async () => {
    fixture = await copyDataFixture('sqlite');
    folder = join(fixture.directory, 'sqlite-files', 'sales', 'orders');
    const file = readdirSync(folder).find((name) => !name.endsWith('-delete.parquet')) ?? '';
    path = join(folder, file);
    backup = join(fixture.directory, 'orders-backup');
    cpSync(folder, backup, { recursive: true });
  });
  afterAll(() => fixture.remove());
  beforeEach(() => {
    rmSync(path, { force: true });
  });

  const restore = (): void => cpSync(backup, folder, { recursive: true });

  it('names the file the catalog lists, the answer of the system and no S3 advice, offers the check of the table, says the same when the folder is gone, and reads again as soon as the file is back', async () => {
    const error = await failure(previewTable(accessFor(fixture), orders));
    expect(error.code).toBe('QUERY_FAILED');
    expect(error.userMessage).toContain('"sales.orders"');
    expect(error.userMessage).toContain(`the catalog lists the data file ${path}`);
    expect(error.userMessage).toContain(`does not exist on this machine (${ANSWER})`);
    expect(error.userMessage).not.toMatch(/S3|aantje\.s3/);
    expect((error.cause as Error).message).toContain(`Cannot open file "${path}"`);
    expect(healthRequestForError(error)).toEqual({
      scope: { kind: 'table', table: orders },
      depth: 'quick',
      reason: 'missing-object',
    });

    // An older snapshot that lists the file: the causes name the writer that removed it, and the read says which
    // snapshot it used and that a newer one exists.
    const pinned = await failure(previewTable(accessFor(fixture, { snapshot: 5 }), orders));
    expect(pinned.userMessage).toContain('an older snapshot still lists a file');
    expect(pinned.userMessage).toMatch(/snapshot @5, the newest is @13.*Show Latest Snapshot\.$/);

    renameSync(folder, `${folder}-moved`);
    try {
      const gone = await failure(previewTable(accessFor(fixture), orders));
      expect(gone.userMessage).toContain(
        `the catalog lists the data file ${path}, but it does not exist on this machine (`,
      );
      expect(healthRequestForError(gone)).toMatchObject({ reason: 'missing-object' });
    } finally {
      renameSync(`${folder}-moved`, folder);
    }

    restore();
    expect(existsSync(path)).toBe(true);
    expect((await previewTable(accessFor(fixture), orders)).rows.map((row) => row[0])).toEqual([1, 3]);
  });

  it('explains the missing file of a query in the SQL editor, and the same session reads on once the file is back', async () => {
    const session = await openSqlSession({ access: accessFor(fixture), mode: 'read-only' });
    try {
      const failed = await events(session, 'SELECT * FROM sales.orders');

      expect(only(failed, 'error')).toHaveLength(1);
      const message = only(failed, 'error')[0]?.message ?? '';
      expect(message).toContain(`the catalog lists the data file ${path}`);
      expect(message).toContain(`does not exist on this machine (${ANSWER})`);
      expect(message).toContain('AT (VERSION => ...)');

      restore();
      const again = await events(session, 'SELECT id FROM sales.orders ORDER BY id');

      expect(only(again, 'resultSet')[0]?.rows).toEqual([[1], [3]]);
    } finally {
      await session.close();
    }
  });
});
