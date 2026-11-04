import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { checkRelation, describeRelation, previewTable, readChanges } from '../../src/data/engine';
import { AantjeError } from '../../src/errors';
import { createLake, engineSkipReason, extensionDirectory } from './data-support';
import type { Lake } from './data-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Case-folding guard tests are skipped: ${skipReason}`);
}

const cleanup = "SELECT * FROM ducklake_cleanup_old_files('lake', cleanup_all => true)";

async function dataFiles(lake: Lake): Promise<string[]> {
  const entries = await readdir(join(dirname(lake.profile.path), 'lake.ducklake.files'), {
    recursive: true,
    withFileTypes: true,
  });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

/** Writes to the metadata of the lake directly, as a hostile author of the catalog can. */
async function editMetadata(lake: Lake, statements: readonly string[]): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
  const connection = await instance.connect();
  try {
    await connection.run(`ATTACH '${lake.profile.path.replaceAll("'", "''")}' AS meta`);
    for (const sql of statements) {
      await connection.run(sql);
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** The newest snapshot of the lake, read from its metadata. */
async function newestSnapshot(lake: Lake): Promise<number> {
  const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
  const connection = await instance.connect();
  try {
    await connection.run(`ATTACH '${lake.profile.path.replaceAll("'", "''")}' AS meta (READ_ONLY)`);
    const rows = (
      await connection.runAndReadAll('SELECT max(snapshot_id) FROM meta.ducklake_snapshot')
    ).getRowsJson();
    return Number(rows[0]?.[0]);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** Three Parquet files that wait for deletion, a live table `t`, and a view `evil` that deletes them when it runs. */
const lakeWithPendingDeletes = (extra: readonly string[] = []): Promise<Lake> =>
  createLake([
    'CREATE TABLE gone (a INTEGER)',
    'INSERT INTO gone VALUES (1)',
    'INSERT INTO gone VALUES (2)',
    'INSERT INTO gone VALUES (3)',
    'CREATE TABLE live (b INTEGER)',
    'INSERT INTO live VALUES (10)',
    'DROP TABLE gone',
    "CALL ducklake_expire_snapshots('lake', older_than => now() + INTERVAL 1 DAY)",
    `CREATE VIEW evil AS ${cleanup}`,
    ...extra,
  ]);

// The view-trust gate has its own tests; these reads are of a trusted connection.
const access = (lake: Lake) => ({ profile: lake.profile, s3: {}, extensionDirectory, viewsTrusted: true });

async function refusal(promise: Promise<unknown>): Promise<AantjeError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(AantjeError);
  return error as AantjeError;
}

describe.skipIf(skipReason)('names that differ only in case', () => {
  it('refuses a table t whose name is also the evil view T, and removes nothing (DuckDB resolves "t" to the view)', async () => {
    const lake = await lakeWithPendingDeletes();
    try {
      // The tree shows the table `t`; the view `T` is a second relation that DuckDB cannot tell from it.
      await editMetadata(lake, ["UPDATE meta.ducklake_view SET view_name = 'T' WHERE view_name = 'evil'"]);
      const before = await dataFiles(lake);

      const table = { schema: 'main', table: 'live' };
      expect((await previewTable(access(lake), table)).rows).toEqual([[10]]);

      await editMetadata(lake, ["UPDATE meta.ducklake_table SET table_name = 't' WHERE table_name = 'live'"]);
      // Show Changes judges the name at the end of its range, so the range ends where both relations exist.
      const newest = await newestSnapshot(lake);
      for (const run of [
        () => previewTable(access(lake), { schema: 'main', table: 't' }),
        () => describeRelation(access(lake), { schema: 'main', table: 't' }),
        () => readChanges(access(lake), { schema: 'main', table: 't' }, { from: 1, to: newest }),
        () => checkRelation(access(lake), { schema: 'main', table: 't' }),
        () => previewTable(access(lake), { schema: 'main', table: 'T' }),
      ]) {
        const error = await refusal(run());
        expect(error.code).toBe('QUERY_FAILED');
        expect(error.userMessage).toMatch(/not read: .*same name when upper and lower case are ignored/);
      }

      expect(await dataFiles(lake)).toEqual(before);
    } finally {
      await lake.remove();
    }
  });

  it('refuses the safe view v and the evil view V alike: the one that is read is the one that is checked', async () => {
    const lake = await lakeWithPendingDeletes(['CREATE VIEW v AS SELECT b FROM live']);
    try {
      await editMetadata(lake, ["UPDATE meta.ducklake_view SET view_name = 'V' WHERE view_name = 'evil'"]);
      const before = await dataFiles(lake);

      for (const name of ['v', 'V']) {
        const error = await refusal(previewTable(access(lake), { schema: 'main', table: name }));
        expect(error.userMessage).toContain('same name when upper and lower case are ignored');
      }

      expect(await dataFiles(lake)).toEqual(before);
    } finally {
      await lake.remove();
    }
  });

  it('judges a view by the name DuckDB resolves: the request in another case still finds the view and refuses it', async () => {
    const lake = await lakeWithPendingDeletes();
    try {
      const before = await dataFiles(lake);

      // DuckDB reads `EVIL` as `evil`; a case-sensitive lookup would find no view and run it unchecked.
      for (const [schema, name] of [
        ['main', 'EVIL'],
        ['MAIN', 'evil'],
        ['Main', 'Evil'],
      ] as const) {
        const error = await refusal(previewTable(access(lake), { schema, table: name }));
        expect(error.userMessage).toContain('its SQL calls "ducklake_cleanup_old_files"');
      }

      expect(await dataFiles(lake)).toEqual(before);
    } finally {
      await lake.remove();
    }
  });

  it('deletes no file outside the lake that the catalog schedules for deletion with an absolute path', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'aantje-victim-'));
    const victim = join(outside, 'precious.txt');
    await writeFile(victim, 'keep me');
    const lake = await lakeWithPendingDeletes(['CREATE TABLE t (a INTEGER)']);
    try {
      await editMetadata(lake, [
        "UPDATE meta.ducklake_view SET view_name = 'T' WHERE view_name = 'evil'",
        `INSERT INTO meta.ducklake_files_scheduled_for_deletion VALUES (999, '${victim.replaceAll('\\', '/').replaceAll("'", "''")}', false, now())`,
      ]);

      await refusal(previewTable(access(lake), { schema: 'main', table: 't' }));

      expect(existsSync(victim)).toBe(true);
    } finally {
      await lake.remove();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not fold letters beyond ASCII, as DuckDB does not: the table É and the view é are two relations', async () => {
    const lake = await createLake([
      'CREATE TABLE "É" (a INTEGER)',
      'INSERT INTO "É" VALUES (1)',
      'CREATE VIEW "é" AS SELECT 2 AS a',
    ]);
    try {
      expect((await previewTable(access(lake), { schema: 'main', table: 'É' })).rows).toEqual([[1]]);
      expect((await previewTable(access(lake), { schema: 'main', table: 'é' })).rows).toEqual([[2]]);
    } finally {
      await lake.remove();
    }
  });

  it('refuses a call through a catalog name that the guard does not know, and allows one through the system catalog', async () => {
    const lake = await createLake(['CREATE TABLE t (a INTEGER)', 'CREATE VIEW unknown_fn AS SELECT 1 AS a']);
    try {
      // A hand-written catalog can store any SQL; a function of a future DuckLake version is not on any list.
      await editMetadata(lake, [
        "UPDATE meta.ducklake_view SET sql = 'SELECT * FROM lake.main.future_maintenance(1)' WHERE view_name = 'unknown_fn'",
      ]);

      const error = await refusal(previewTable(access(lake), { schema: 'main', table: 'unknown_fn' }));
      expect(error.userMessage).toContain(
        'its SQL calls "lake.main.future_maintenance", which is reached through a catalog or schema name',
      );

      await editMetadata(lake, [
        "UPDATE meta.ducklake_view SET sql = 'SELECT system.main.abs(-3) AS a' WHERE view_name = 'unknown_fn'",
      ]);
      expect((await previewTable(access(lake), { schema: 'main', table: 'unknown_fn' })).rows).toEqual([[3]]);
    } finally {
      await lake.remove();
    }
  });

  it('refuses a bare call of a lake function that the engine lists and that no fixed list of the guard names', async () => {
    // DuckLake stores `lake.f()` as the bare `f()`. `ducklake_commit` exists in this DuckDB, so a catalog can store
    // `commit()`; the guard must take the names from the engine, not from a list that an older version wrote.
    const lake = await createLake(['CREATE TABLE t (a INTEGER)', 'CREATE VIEW bare AS SELECT 1 AS a']);
    try {
      await editMetadata(lake, [
        "UPDATE meta.ducklake_view SET sql = 'SELECT * FROM commit()' WHERE view_name = 'bare'",
      ]);

      const error = await refusal(previewTable(access(lake), { schema: 'main', table: 'bare' }));
      expect(error.userMessage).toContain(
        'The view "main.bare" is not run: its SQL calls "commit", which can change the lake or delete its files',
      );
    } finally {
      await lake.remove();
    }
  });

  it('refuses a maintenance function of the lake although a macro of the lake carries its name: the built-in wins', async () => {
    const lake = await createLake([
      'CREATE TABLE t (a INTEGER)',
      'CREATE MACRO merge_adjacent_files() AS TABLE SELECT 1 AS a',
      'CREATE VIEW shadowed AS SELECT 1 AS a',
    ]);
    try {
      await editMetadata(lake, [
        "UPDATE meta.ducklake_view SET sql = 'SELECT * FROM lake.main.merge_adjacent_files()' WHERE view_name = 'shadowed'",
      ]);

      const error = await refusal(previewTable(access(lake), { schema: 'main', table: 'shadowed' }));
      expect(error.userMessage).toMatch(
        /The view "main\.shadowed" is not run: its SQL calls "(lake\.main\.)?merge_adjacent_files", which can change the lake/,
      );
    } finally {
      await lake.remove();
    }
  });

  it('refuses a view that reads a relation of another catalog, including the DuckDB metadata database', async () => {
    const lake = await createLake(['CREATE TABLE t (a INTEGER)', 'CREATE VIEW reach AS SELECT a FROM t']);
    try {
      // A hand-written metadata file can store a view that reaches out of the lake: the DuckDB metadata database next to
      // it (which can hold a view that calls a maintenance function aantje cannot see), or the engine's own `memory`.
      for (const sql of [
        'SELECT * FROM __ducklake_metadata_lake.main.ducklake_snapshot', // three-part catalog name
        'SELECT * FROM __ducklake_metadata_lake.ducklake_snapshot', // two-part: the schema position is the catalog
        'SELECT * FROM memory.main.anything',
      ]) {
        await editMetadata(lake, [
          `UPDATE meta.ducklake_view SET sql = '${sql.replaceAll("'", "''")}' WHERE view_name = 'reach'`,
        ]);
        const error = await refusal(previewTable(access(lake), { schema: 'main', table: 'reach' }));
        expect(error.userMessage).toContain('The view "main.reach" is not run: ');
        expect(error.userMessage).toContain('which is not the lake');
      }
    } finally {
      await lake.remove();
    }
  });

  it('previews a harmless table and view as before', async () => {
    const lake = await createLake([
      'CREATE TABLE Orders (a INTEGER)',
      'INSERT INTO Orders VALUES (5)',
      'CREATE VIEW Seen AS SELECT a FROM orders',
    ]);
    try {
      expect((await previewTable(access(lake), { schema: 'main', table: 'orders' })).rows).toEqual([[5]]);
      expect((await previewTable(access(lake), { schema: 'main', table: 'SEEN' })).rows).toEqual([[5]]);
      await checkRelation(access(lake), { schema: 'main', table: 'Seen' });
    } finally {
      await lake.remove();
    }
  });
});

describe.skipIf(skipReason)('a view that talks to a Quack server', () => {
  it('is refused before it runs: quack_query would run its SQL on the server with the token of the user who previews it', async () => {
    const lake = await createLake(['CREATE TABLE t (a INTEGER)', 'CREATE VIEW served AS SELECT 1 AS a']);
    try {
      await editMetadata(lake, [
        "UPDATE meta.ducklake_view SET sql = 'SELECT * FROM quack_query(''quack:duckdb:9494'', ''DROP TABLE t'')' WHERE view_name = 'served'",
      ]);

      for (const read of [previewTable, describeRelation, checkRelation]) {
        const error = await refusal(read(access(lake), { schema: 'main', table: 'served' }));
        expect(error.code).toBe('QUERY_FAILED');
        expect(error.userMessage).toContain('"quack_query"');
      }
    } finally {
      await lake.remove();
    }
  });
});
