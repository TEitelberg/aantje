import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDuckdb } from '../../src/catalog/drivers/duckdb';
import { previewTable } from '../../src/data/engine';
import { AantjeError } from '../../src/errors';
import { openSqlSession } from '../../src/sql/session';
import type { SqlEvent, SqlSession } from '../../src/sql/session';
import { accessFor, copyDataFixture, createLake, engineSkipReason, extensionDirectory } from './data-support';
import type { DataFixture } from './data-support';
import { copyHistoryFixture } from './history-support';
import { events, only, openFixtureSession, openReader, query, snapshotIds } from './sql-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`SQL session tests are skipped: ${skipReason}`);
}

const ORDER_1 = [1, '{"name":"a","tags":["x"]}', '[{"key":"k","value":1}]', '1.50', '2026-01-01 00:00:00'];
const ORDER_3 = [3, null, null, '3.00', '2026-01-03 00:00:00'];
const BOM = String.fromCharCode(0xfeff);
const LONG_QUERY = 'SELECT count(*) FROM range(100000000000)';

/** What a script reported, without the timings. */
function plain(list: readonly SqlEvent[]): Record<string, unknown>[] {
  return list.map((event) => {
    const { elapsedMs: _elapsed, ...rest } = event as SqlEvent & { elapsedMs?: number };
    return rest;
  });
}

function failure(promise: Promise<unknown>): Promise<AantjeError> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(AantjeError);
      return error as AantjeError;
    },
  );
}

/** Counts what the session does to the real DuckDB classes, to prove that nothing is left open. */
function watchEngine(): { counts: () => Record<string, number>; interrupts: () => number } {
  const instances = vi.spyOn(DuckDBInstance, 'create');
  const instanceCloses = vi.spyOn(DuckDBInstance.prototype, 'closeSync');
  const connections = vi.spyOn(DuckDBInstance.prototype, 'connect');
  const connectionCloses = vi.spyOn(DuckDBConnection.prototype, 'closeSync');
  const interrupts = vi.spyOn(DuckDBConnection.prototype, 'interrupt');
  return {
    counts: () => ({
      instances: instances.mock.calls.length,
      instanceCloses: instanceCloses.mock.calls.length,
      connections: connections.mock.calls.length,
      connectionCloses: connectionCloses.mock.calls.length,
    }),
    interrupts: () => interrupts.mock.calls.length,
  };
}
const CLOSED = { instances: 1, instanceCloses: 1, connections: 2, connectionCloses: 2 };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function copy(kind: 'sqlite' | 'duckdb'): Promise<DataFixture> {
  const fixture = await copyDataFixture(kind);
  cleanups.push(() => fixture.remove());
  return fixture;
}

/** Runs `use` on a fresh in-memory DuckDB with the extensions loaded. */
async function withEngine<T>(use: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
  const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
  const connection = await instance.connect();
  try {
    await connection.run('LOAD sqlite');
    return await use(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** The tables of a database file, read directly and read-only. */
function tablesOf(path: string, kind: 'sqlite' | 'duckdb'): Promise<string[]> {
  return withEngine(async (connection) => {
    await connection.run(`ATTACH '${path.replaceAll("'", "''")}' AS file (TYPE ${kind}, READ_ONLY)`);
    const result = await connection.runAndReadAll(
      "SELECT table_name FROM duckdb_tables() WHERE database_name = 'file' ORDER BY table_name",
    );
    return result.getRowsJson().map(([name]) => name as string);
  });
}

/** A private copy of the data fixture and a session on it; both are removed after the test. */
async function openCopy(
  kind: 'sqlite' | 'duckdb',
  mode: 'read-write' | 'read-only' = 'read-write',
): Promise<{ fixture: DataFixture; session: SqlSession }> {
  const fixture = await copy(kind);
  const session = await openFixtureSession(fixture, mode);
  cleanups.push(() => session.close());
  return { fixture, session };
}

describe.skipIf(skipReason)('the SQL session', () => {
  describe.each(['sqlite', 'duckdb'] as const)('on a %s catalog', (kind) => {
    it('returns the rows of a SELECT like the grid preview and runs DDL and DML one run after the other', async () => {
      const fixture = await copyDataFixture(kind);
      cleanups.push(() => fixture.remove());
      // A DuckDB file is locked by a writable session: read the preview first.
      const preview = await previewTable(accessFor(fixture), { schema: 'sales', table: 'orders' });
      const session = await openFixtureSession(fixture);
      cleanups.push(() => session.close());

      const result = await query(session, 'SELECT * FROM sales.orders');

      expect(result.columns).toEqual(preview.columns);
      expect(result.rows).toEqual([ORDER_1, ORDER_3]);
      expect(result.rows).toEqual(preview.rows);
      expect(result.truncated).toBe(false);

      const affected: (number | undefined)[] = [];
      for (const sql of [
        'CREATE TABLE made (id INTEGER, name VARCHAR)',
        "INSERT INTO made VALUES (1, 'a'), (2, 'b'), (3, 'c')",
        'UPDATE made SET name = upper(name) WHERE id > 1',
        'DELETE FROM made WHERE id = 3',
        'ALTER TABLE made ADD COLUMN extra DOUBLE',
        'CREATE VIEW made_view AS SELECT id, name FROM made',
        'CREATE MACRO plus_one(x) AS x + 1',
      ]) {
        const [message] = only(await events(session, sql), 'message');
        affected.push(message?.rowsAffected);
      }
      expect(affected).toEqual([undefined, 3, 2, 1, undefined, undefined, undefined]);
      expect((await query(session, 'SELECT id, name, extra FROM made ORDER BY id')).rows).toEqual([
        [1, 'a', null],
        [2, 'B', null],
      ]);
      expect((await query(session, 'SELECT * FROM made_view ORDER BY id')).rows).toEqual([
        [1, 'a'],
        [2, 'B'],
      ]);
      expect((await query(session, 'SELECT plus_one(41)')).rows).toEqual([[42]]);

      for (const sql of ['DROP VIEW made_view', 'DROP TABLE made', 'DROP MACRO plus_one']) {
        expect(only(await events(session, sql), 'message'), sql).toHaveLength(1);
      }
      expect(only(await events(session, 'SELECT * FROM made'), 'error')[0]?.message).toContain('made');
    });

    it('lets the Explorer see every committed change as a new snapshot, and keeps a few rows inlined until the limit is 0', async () => {
      const { fixture, session } = await openCopy(kind);
      const before = await snapshotIds(fixture).catch(() => undefined);
      if (kind === 'sqlite') expect(before?.[0]).toBe(13);
      await events(
        session,
        'CREATE TABLE seen (a INTEGER); INSERT INTO seen VALUES (1); UPDATE seen SET a = 2; DELETE FROM seen',
      );
      await session.close();

      const reader = await openReader(fixture);
      try {
        const snapshots = await reader.snapshots();
        expect(snapshots.map(({ id }) => id).slice(0, 5)).toEqual([17, 16, 15, 14, 13]);
        expect(snapshots[3]?.changes).toBe('created_table:"main"."seen"');
        const main = (await reader.schemas(17)).find(({ name }) => name === 'main');
        const tables = await reader.tables(main?.id ?? -1, 17);
        expect(tables.map(({ name }) => name).sort()).toEqual(['plain', 'seen']);
      } finally {
        await reader.close();
      }

      const inlined = await openCopy(kind);
      await events(inlined.session, 'CREATE TABLE small (a INTEGER); INSERT INTO small VALUES (1), (2), (3)');
      expect((await query(inlined.session, 'SELECT count(*)::INTEGER FROM small')).rows).toEqual([[3]]);
      await events(
        inlined.session,
        "CALL lake.set_option('data_inlining_row_limit', 0); INSERT INTO small VALUES (4), (5)",
      );
      expect((await query(inlined.session, 'SELECT count(*)::INTEGER FROM small')).rows).toEqual([[5]]);
      await inlined.session.close();

      const second = await openReader(inlined.fixture);
      try {
        const snapshot = (await second.info()).latestSnapshot;
        const main = (await second.schemas(snapshot)).find(({ name }) => name === 'main');
        const small = (await second.tables(main?.id ?? -1, snapshot)).find(({ name }) => name === 'small');
        // Only the two rows that were written to a Parquet file are counted; the three inlined ones are not.
        expect(small?.stats).toMatchObject({ rows: 2, files: 1 });
      } finally {
        await second.close();
      }
    });

    it('commits an explicit transaction as one snapshot, and rolls back leaves no trace, also when the session closes', async () => {
      const { fixture, session } = await openCopy(kind);
      const states: string[] = [];
      const step = async (script: string): Promise<SqlEvent[]> => {
        const list = await events(session, script);
        states.push(session.inTransaction);
        return list;
      };

      await step('BEGIN');
      await step('CREATE TABLE tx (a INTEGER)');
      await step('INSERT INTO tx VALUES (1), (2)');
      const inside = await step('SELECT count(*)::INTEGER FROM tx');
      await step('COMMIT');
      await session.close();

      expect(states).toEqual(['open', 'open', 'open', 'open', 'none']);
      expect(only(inside, 'resultSet')[0]?.rows).toEqual([[2]]);
      expect((await snapshotIds(fixture))[0]).toBe(14);

      const rolled = await openCopy(kind);
      await events(rolled.session, 'BEGIN; CREATE TABLE gone (a INTEGER); INSERT INTO gone VALUES (1)');
      expect(rolled.session.inTransaction).toBe('open');
      await events(rolled.session, 'ROLLBACK');
      expect(rolled.session.inTransaction).toBe('none');
      expect(only(await events(rolled.session, 'SELECT * FROM gone'), 'error')).toHaveLength(1);
      await rolled.session.close();
      expect((await snapshotIds(rolled.fixture))[0]).toBe(13);

      const closing = await openCopy(kind);
      await events(closing.session, 'BEGIN; CREATE TABLE lost (a INTEGER); INSERT INTO lost VALUES (1)');
      await closing.session.close();
      expect(closing.session.inTransaction).toBe('none');
      expect((await snapshotIds(closing.fixture))[0]).toBe(13);
    });

    it('refuses every write in a read-only session and changes nothing', async () => {
      const { fixture, session } = await openCopy(kind, 'read-only');
      const attempts = [
        'CREATE TABLE nope (a INTEGER)',
        'INSERT INTO sales.orders (id) VALUES (9)',
        'UPDATE sales.orders SET id = 9',
        'DELETE FROM sales.orders',
        'ALTER TABLE sales.orders ADD COLUMN q INTEGER',
        "COMMENT ON TABLE sales.orders IS 'x'",
        'DROP TABLE sales.orders',
        'CREATE VIEW nope AS SELECT 1',
      ];
      const messages = new Set<string | undefined>();
      for (const sql of attempts) {
        const list = await events(session, sql);
        const errors = only(list, 'error');
        expect(errors, sql).toHaveLength(1);
        expect(errors[0]?.index, sql).toBe(0);
        messages.add(errors[0]?.message);
      }
      // One friendly text for every refused write, not the raw engine message of each.
      expect(messages.size).toBe(1);

      expect((await query(session, 'SELECT id FROM sales.orders ORDER BY id')).rows).toEqual([[1], [3]]);
      await events(
        session,
        'CREATE TEMP TABLE scratch AS SELECT 1 AS a; BEGIN; SELECT * FROM scratch; COMMIT',
      );
      expect(session.mode).toBe('read-only');
      await session.close();
      expect((await snapshotIds(fixture))[0]).toBe(13);
    });
  });

  it('follows every spelling of a transaction, keeps it alive after a binder error and aborts it on a runtime error', async () => {
    const { session } = await openCopy('sqlite');
    const states: string[] = [];
    for (const sql of [
      'START TRANSACTION',
      'END',
      'begin transaction',
      'ABORT',
      'BEGIN',
      'COMMIT',
      'BEGIN',
      'rollback',
    ]) {
      await events(session, sql);
      states.push(session.inTransaction);
    }
    expect(states).toEqual(['open', 'none', 'open', 'none', 'open', 'none', 'open', 'none']);

    // An error of the parser or the binder does not invalidate the transaction, as the setting says.
    await events(session, 'BEGIN; CREATE TABLE alive (a INTEGER)');
    expect(only(await events(session, 'SELECT * FROM nonexist'), 'error')).toHaveLength(1);
    expect(session.inTransaction).toBe('open');
    await events(session, 'INSERT INTO alive VALUES (7); COMMIT');
    expect(session.inTransaction).toBe('none');
    expect((await query(session, 'SELECT * FROM alive')).rows).toEqual([[7]]);

    // A runtime error aborts it: the engine refuses every statement until ROLLBACK.
    await events(session, 'BEGIN');
    expect(only(await events(session, "SELECT CAST('x' AS INTEGER)"), 'error')).toHaveLength(1);
    expect(session.inTransaction).toBe('aborted');
    expect(only(await events(session, 'SELECT 1'), 'error')).toHaveLength(1);
    expect(session.inTransaction).toBe('aborted');
    await events(session, 'BEGIN');
    expect(session.inTransaction).toBe('aborted');
    await events(session, 'ROLLBACK');
    expect(session.inTransaction).toBe('none');
    expect(only(await events(session, 'COMMIT'), 'error')).toHaveLength(1);
    expect(only(await events(session, 'ROLLBACK'), 'error')).toHaveLength(1);
    expect(session.inTransaction).toBe('none');
    expect((await query(session, 'SELECT 1')).rows).toEqual([[1]]);
  });

  describe.each(['sqlite', 'duckdb'] as const)('a read-only session on a %s catalog with history', (kind) => {
    it('refuses the maintenance calls that change the catalog, and shows what READ_ONLY does not stop', async () => {
      const fixture = await copyHistoryFixture(kind);
      cleanups.push(() => fixture.remove());
      const session = await openFixtureSession(fixture, 'read-only');
      cleanups.push(() => session.close());
      const latestSnapshot = async (): Promise<number> =>
        Number((await query(session, 'SELECT max(snapshot_id) FROM lake.snapshots()')).rows[0]?.[0]);
      const dataFiles = async (): Promise<number> =>
        (
          await readdir(join(fixture.directory, `${kind}-files`), { recursive: true, withFileTypes: true })
        ).filter((entry) => entry.isFile()).length;

      // READ_ONLY does not stop ducklake_delete_orphaned_files: it deletes for real, without an error.
      const orphan = join(fixture.directory, `${kind}-files`, 'orphan-not-in-the-catalog.parquet');
      await writeFile(orphan, 'not a parquet file');
      const withOrphan = await dataFiles();
      const list = await events(
        session,
        "CALL ducklake_delete_orphaned_files('lake', older_than => now() + INTERVAL 1 DAY)",
      );
      expect(only(list, 'error')).toEqual([]);
      expect(only(list, 'resultSet')[0]?.rows.flat().join(' ')).toContain(
        'orphan-not-in-the-catalog.parquet',
      );
      expect(await dataFiles()).toBe(withOrphan - 1);

      const before = await latestSnapshot();
      for (const sql of [
        "CALL lake.set_option('data_inlining_row_limit', 5)",
        "CALL ducklake_expire_snapshots('lake', versions => [1])",
        "CALL ducklake_merge_adjacent_files('lake')",
        "CALL ducklake_flush_inlined_data('lake')",
        'CHECKPOINT lake',
      ]) {
        expect(only(await events(session, sql), 'error'), sql).toHaveLength(1);
      }
      expect(await latestSnapshot()).toBe(before);

      // The files that are scheduled for deletion are deleted before the error is reported.
      const files = await dataFiles();
      const cleanup = await events(session, "CALL ducklake_cleanup_old_files('lake', cleanup_all => true)");
      expect(only(cleanup, 'error')).toHaveLength(1);
      expect(await dataFiles()).toBeLessThan(files);

      // READ_ONLY protects only the attached name: a second writable ATTACH of a SQLite catalog changes
      // the lake, while a DuckDB file is locked within the process.
      const path = fixture.profile.path.replaceAll('\\', '/');
      const bypass = await events(
        session,
        `ATTACH 'ducklake:${kind === 'sqlite' ? 'sqlite:' : ''}${path}' AS second; CREATE TABLE second.main.bypass (a INTEGER)`,
      );
      if (kind === 'sqlite') {
        expect(only(bypass, 'error')).toEqual([]);
        expect(await latestSnapshot()).toBe(before + 1);
      } else {
        expect(only(bypass, 'error')[0]?.message).toMatch(/already attached/);
        expect(await latestSnapshot()).toBe(before);
      }
    });
  });

  describe('a script', () => {
    it('stops at the first failing statement and puts the positions into the script', async () => {
      const { session } = await openCopy('sqlite');
      const script = 'SELECT 1 AS one;\nSELECT * FROM nonexist_table;\nCREATE TABLE never_made (a INTEGER)';

      const list = await events(session, script);

      expect(plain(list.slice(0, 3))).toEqual([
        { kind: 'start', index: 0, statementType: 'SELECT', sql: 'SELECT 1 AS one', offset: 0 },
        {
          kind: 'resultSet',
          index: 0,
          columns: [{ name: 'one', type: 'INTEGER', kind: 'number' }],
          rows: [[1]],
          truncated: false,
        },
        {
          kind: 'start',
          index: 1,
          statementType: 'SELECT',
          sql: 'SELECT * FROM nonexist_table',
          offset: script.indexOf('SELECT * FROM nonexist_table'),
        },
      ]);
      expect(list[3]).toMatchObject({
        kind: 'error',
        index: 1,
        position: { offset: script.indexOf('nonexist_table'), length: 'nonexist_table'.length },
      });
      expect(only(await events(session, 'SELECT * FROM never_made'), 'error')).toHaveLength(1);

      // A byte order mark counts as one character, like every other.
      const withBom = `${BOM}SELECT 1; SELEC 2`;
      expect(only(await events(session, withBom), 'error')[0]?.position).toEqual({
        offset: withBom.indexOf('SELEC 2'),
        length: 5,
      });
      expect(only(await events(session, `${BOM}-- c\nSELECT 7`), 'start')[0]?.offset).toBe(6);

      // Non-ASCII text and CRLF line breaks before the error.
      const crlf = [
        "SELECT 'ä€😀' AS first;",
        '-- Comment with Ümläuts and 漢字',
        "SELECT 'ö😀' AS a,",
        '       nonexist_col, 7 AS z',
        '  FROM sales.orders;',
        'SELECT 3',
      ].join('\r\n');
      const crlfList = await events(session, crlf);
      const starts = only(crlfList, 'start');
      expect(starts.map(({ offset }) => offset)).toEqual([0, crlf.indexOf("SELECT 'ö😀'")]);
      for (const { sql, offset } of starts) expect(crlf.slice(offset, offset + sql.length)).toBe(sql);
      expect(only(crlfList, 'error')[0]?.position).toEqual({
        offset: crlf.indexOf('nonexist_col'),
        length: 'nonexist_col'.length,
      });

      // A statement that does not parse stops the whole script before anything runs.
      const bad = "CREATE TABLE never (a INTEGER);\r\nSELECT 'ä€😀' AS x;\r\nSELEC 1";
      const parsed = await events(session, bad);
      expect(plain(parsed)).toMatchObject([
        { kind: 'error', index: 0, position: { offset: bad.indexOf('SELEC 1'), length: 5 } },
      ]);
      expect(only(await events(session, 'SELECT * FROM never'), 'error')).toHaveLength(1);
    });

    it('splits at semicolons only where a statement ends, answers an empty script with a message and times a statement', async () => {
      const { session } = await openCopy('sqlite');
      const script = [
        'CREATE TABLE hostile (s VARCHAR, "we;ird" INTEGER); -- trailing; comment',
        "INSERT INTO hostile VALUES ('a;b', 1), ($$c;d$$, 2), ('it''s;', 3); /* x; y */",
        ';; /* nothing */ ;',
        'SELECT s, "we;ird" FROM hostile ORDER BY 2; -- the end',
      ].join('\n');

      const list = await events(session, script);

      expect(only(list, 'start')).toHaveLength(3);
      expect(only(list, 'error')).toEqual([]);
      expect(only(list, 'resultSet')[0]?.rows).toEqual([
        ['a;b', 1],
        ['c;d', 2],
        ["it's;", 3],
      ]);

      for (const empty of ['', '  \r\n ', '-- nothing', '/* a */; -- b']) {
        const reported = await events(session, empty);
        expect(
          plain(reported).map(({ kind, index }) => [kind, index]),
          JSON.stringify(empty),
        ).toEqual([['message', 0]]);
      }

      const run = Object.getOwnPropertyDescriptor(DuckDBConnection.prototype, 'prepare')
        ?.value as DuckDBConnection['prepare'];
      vi.spyOn(DuckDBConnection.prototype, 'prepare').mockImplementation(async function (
        this: DuckDBConnection,
        sql,
      ) {
        await sleep(150);
        return run.call(this, sql);
      });
      const timed = await events(
        session,
        'CREATE TABLE timed (a INTEGER); SELECT 1; INSERT INTO timed VALUES (1)',
      );
      const [created, inserted] = only(timed, 'message');
      expect(created?.elapsedMs).toBeGreaterThanOrEqual(100);
      expect(only(timed, 'resultSet')[0]?.elapsedMs).toBeGreaterThanOrEqual(100);
      expect(inserted).toMatchObject({ index: 2, rowsAffected: 1 });
      expect(inserted?.elapsedMs).toBeGreaterThanOrEqual(100);
    });
  });

  describe('the row limit', () => {
    it('cuts a result at maxRows, takes the default of the session unless the run overrides it, and runs RETURNING to the end', async () => {
      const { session } = await openCopy('sqlite');

      const cut = await events(session, 'SELECT range::INTEGER AS n FROM range(25)', { maxRows: 10 });
      const exact = await events(session, 'SELECT range::INTEGER AS n FROM range(10)', { maxRows: 10 });
      const bigger = await events(session, 'SELECT range::INTEGER AS n FROM range(2500)', { maxRows: 2048 });
      expect(only(cut, 'resultSet')[0]).toMatchObject({
        truncated: true,
        rows: [[0], [1], [2], [3], [4], [5], [6], [7], [8], [9]],
      });
      expect(only(exact, 'resultSet')[0]).toMatchObject({ truncated: false });
      expect(only(exact, 'resultSet')[0]?.rows).toHaveLength(10);
      expect(only(bigger, 'resultSet')[0]).toMatchObject({ truncated: true });
      expect(only(bigger, 'resultSet')[0]?.rows).toHaveLength(2048);

      const limited = await openFixtureSession(await copyDataFixture('sqlite'), 'read-only', { maxRows: 3 });
      cleanups.push(() => limited.close());
      const normal = only(await events(session, 'SELECT range FROM range(10001)'), 'resultSet')[0];
      const small = only(await events(limited, 'SELECT range FROM range(10)'), 'resultSet')[0];
      const overridden = only(
        await events(limited, 'SELECT range FROM range(10)', { maxRows: 5 }),
        'resultSet',
      )[0];
      expect([normal?.rows.length, normal?.truncated]).toEqual([10_000, true]);
      expect([small?.rows.length, small?.truncated]).toEqual([3, true]);
      expect([overridden?.rows.length, overridden?.truncated]).toEqual([5, true]);

      // DuckLake itself does not support RETURNING on insert, a temporary table does.
      await events(session, 'CREATE TEMP TABLE ret (a INTEGER)');
      const [returned] = only(
        await events(session, 'INSERT INTO ret SELECT range::INTEGER FROM range(50) RETURNING a', {
          maxRows: 5,
        }),
        'resultSet',
      );
      expect(returned).toMatchObject({ truncated: true });
      expect(returned?.rows).toHaveLength(5);
      expect((await query(session, 'SELECT count(*)::INTEGER FROM ret')).rows).toEqual([[50]]);
    });

    it('does not read a result of five million rows into memory', async () => {
      const { session } = await openCopy('sqlite');
      const rssBefore = process.memoryUsage().rss;
      const started = performance.now();

      const [result] = only(
        await events(session, "SELECT range AS n, repeat('x', 40) AS s FROM range(5000000)"),
        'resultSet',
      );

      expect(result?.rows).toHaveLength(10_000);
      expect(result?.truncated).toBe(true);
      expect(performance.now() - started).toBeLessThan(5000);
      expect(process.memoryUsage().rss - rssBefore).toBeLessThan(400 * 1024 * 1024);
      // The stream was closed: the connection takes the next statement at once.
      expect((await query(session, 'SELECT 1')).rows).toEqual([[1]]);
    });
  });

  describe('cancel', () => {
    it('interrupts a long query and skips the rest, does nothing when no script runs, and stops at an abort signal', async () => {
      const { session } = await openCopy('sqlite');
      const started = performance.now();
      const running = events(session, `${LONG_QUERY}; SELECT 2`);

      await sleep(300);
      session.cancel();
      const list = await running;

      expect(plain(list).map(({ kind }) => kind)).toEqual(['start', 'error']);
      expect(performance.now() - started).toBeLessThan(8000);
      expect((await query(session, 'SELECT 40 + 2')).rows).toEqual([[42]]);

      session.cancel();
      expect((await query(session, 'SELECT 1')).rows).toEqual([[1]]);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const during = await events(session, LONG_QUERY, { signal: controller.signal });
      const before = await events(session, 'SELECT 1; SELECT 2', { signal: AbortSignal.abort() });
      expect(only(during, 'error')).toHaveLength(1);
      expect(plain(before).map(({ kind }) => kind)).toEqual(['start', 'error']);
      expect((await query(session, 'SELECT 1')).rows).toEqual([[1]]);
    });

    it('ignores the signal of an earlier run, repeats the interrupt until the statement has ended and until it has started', async () => {
      const { session } = await openCopy('sqlite');
      const earlier = new AbortController();
      await events(session, 'SELECT 1', { signal: earlier.signal });
      let ended = false;
      const first = events(session, LONG_QUERY).then((list) => {
        ended = true;
        return list;
      });
      await sleep(300);
      earlier.abort();
      await sleep(700);
      expect(ended).toBe(false);
      session.cancel();
      await first;

      const watch = watchEngine();
      const second = events(session, LONG_QUERY);
      await sleep(300);
      session.cancel();
      await second;
      const interrupts = watch.interrupts();
      await sleep(300);
      expect(interrupts).toBeGreaterThanOrEqual(1);
      expect(watch.interrupts()).toBe(interrupts);
      vi.restoreAllMocks();

      // The engine drops an interrupt that comes before the statement has started.
      const prepare = Object.getOwnPropertyDescriptor(DuckDBConnection.prototype, 'prepare')
        ?.value as DuckDBConnection['prepare'];
      vi.spyOn(DuckDBConnection.prototype, 'prepare').mockImplementation(async function (
        this: DuckDBConnection,
        sql,
      ) {
        const prepared = await prepare.call(this, sql);
        await sleep(500);
        return prepared;
      });
      const started = performance.now();
      const third = events(session, LONG_QUERY);
      await sleep(100);
      session.cancel();
      expect(only(await third, 'error')).toHaveLength(1);
      expect(performance.now() - started).toBeLessThan(8000);
    });

    it('aborts the transaction when it cancels a statement inside it, rejects a second run and a run on a closed session', async () => {
      const { session } = await openCopy('sqlite');
      await events(session, 'BEGIN; CREATE TABLE cancelled (a INTEGER)');
      const running = events(session, LONG_QUERY);
      await sleep(300);

      session.cancel();
      await running;

      expect(session.inTransaction).toBe('aborted');
      await events(session, 'ROLLBACK');
      expect(session.inTransaction).toBe('none');
      expect(only(await events(session, 'SELECT * FROM cancelled'), 'error')).toHaveLength(1);

      const busy = events(session, LONG_QUERY);
      await sleep(200);
      await failure(events(session, 'SELECT 1'));
      session.cancel();
      await busy;
      await session.close();
      await failure(events(session, 'SELECT 1'));
    });
  });

  describe('the session settings', () => {
    it('lets the user change the configuration but not install, load or store secrets, works on the latest snapshot and runs the DuckLake functions', async () => {
      const { session } = await openCopy('sqlite');

      expect(only(await events(session, 'SET threads = 2'), 'error')).toEqual([]);
      const settings = await query(
        session,
        "SELECT name, value FROM duckdb_settings() WHERE name IN ('autoinstall_known_extensions', 'autoload_known_extensions', 'allow_persistent_secrets', 'lock_configuration', 'default_transaction_invalidation_policy') ORDER BY name",
      );
      expect(settings.rows).toEqual([
        ['allow_persistent_secrets', 'false'],
        ['autoinstall_known_extensions', 'false'],
        ['autoload_known_extensions', 'false'],
        ['default_transaction_invalidation_policy', 'SYNTACTIC_ERRORS_DO_NOT_INVALIDATE'],
        ['lock_configuration', 'false'],
      ]);
      const persistent = only(
        await events(
          session,
          "LOAD httpfs; CREATE PERSISTENT SECRET stored (TYPE s3, KEY_ID 'a', SECRET 'b')",
        ),
        'error',
      );
      expect(persistent[0]?.message).toMatch(/persistent secrets are disabled/i);

      // The snapshot of the access is ignored; AT (VERSION => n) travels in time.
      const fixture = await copyDataFixture('sqlite');
      cleanups.push(() => fixture.remove());
      const atFive = await openSqlSession({
        access: accessFor(fixture, { snapshot: 5 }),
        mode: 'read-write',
      });
      cleanups.push(() => atFive.close());
      expect((await query(atFive, 'SELECT id FROM sales.orders ORDER BY id')).rows).toEqual([[1], [3]]);
      expect((await query(atFive, 'SELECT id FROM sales.orders AT (VERSION => 5) ORDER BY id')).rows).toEqual(
        [[1], [2], [3]],
      );
      expect((await query(atFive, 'SELECT max(snapshot_id)::INTEGER FROM lake.snapshots()')).rows).toEqual([
        [13],
      ]);

      const history = await copyHistoryFixture('sqlite');
      cleanups.push(() => history.remove());
      const historySession = await openFixtureSession(history, 'read-only');
      cleanups.push(() => historySession.close());
      const result = await query(
        historySession,
        'SELECT count(*) > 3 AS many, max(snapshot_id)::INTEGER FROM lake.snapshots()',
      );
      expect(result.rows[0]?.[0]).toBe(true);
      expect(result.rows[0]?.[1]).toBe((await snapshotIds(history))[0]);
    });
  });

  describe('opening and closing', () => {
    it('closes the instance and both connections in every situation, rolls back before closing and cancels a running statement', async () => {
      const fixture = await copy('sqlite');
      let watch = watchEngine();
      const running = await openFixtureSession(fixture);
      const list = events(running, LONG_QUERY);
      await sleep(300);
      const started = performance.now();
      await running.close();
      expect(only(await list, 'error')).toHaveLength(1);
      await running.close();
      expect(performance.now() - started).toBeLessThan(8000);
      expect(watch.counts()).toEqual(CLOSED);
      vi.restoreAllMocks();

      // An open transaction is rolled back before the connection closes, and only then.
      const { session } = await openCopy('sqlite');
      const run = vi.spyOn(DuckDBConnection.prototype, 'run');
      const close = vi.spyOn(DuckDBConnection.prototype, 'closeSync');
      await events(session, 'BEGIN');
      await session.close();
      const rollback = run.mock.calls.findIndex(([sql]) => sql === 'ROLLBACK');
      expect(rollback).toBeGreaterThanOrEqual(0);
      expect(run.mock.invocationCallOrder[rollback]).toBeLessThan(close.mock.invocationCallOrder[0] ?? 0);
      const idle = await openCopy('sqlite');
      run.mockClear();
      await idle.session.close();
      expect(run.mock.calls.map(([sql]) => sql)).toEqual([]);
      vi.restoreAllMocks();

      // The reader of the events stopped in the middle of a script.
      const stoppedFixture = await copy('sqlite');
      watch = watchEngine();
      const stopped = await openFixtureSession(stoppedFixture);
      const iterator = stopped.run('SELECT 1; SELECT 2')[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ kind: 'start', index: 0 });
      await stopped.close();
      await iterator.return?.();
      expect(watch.counts()).toEqual(CLOSED);
      vi.restoreAllMocks();

      // A failed run.
      const failedFixture = await copy('sqlite');
      watch = watchEngine();
      const failed = await openFixtureSession(failedFixture);
      await events(failed, 'SELECT 1; SELECT x');
      await failed.close();
      expect(watch.counts()).toEqual(CLOSED);
    });

    it('closes everything when opening fails, never creates a catalog and leaves a file that is no DuckLake as it was', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'aantje-notacatalog-'));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const file = join(directory, 'garbage.duckdb');
      await writeFile(file, 'this is not a database file at all');
      let watch = watchEngine();
      const garbage = await failure(
        openSqlSession({
          access: { profile: { id: 'x', name: 'x', kind: 'duckdb', path: file }, s3: {}, extensionDirectory },
          mode: 'read-write',
        }),
      );
      expect(garbage.code).toBe('CONNECTION_FAILED');
      expect(watch.counts()).toEqual(CLOSED);
      vi.restoreAllMocks();

      const fixture = await copy('sqlite');
      const connect = Object.getOwnPropertyDescriptor(DuckDBInstance.prototype, 'connect')
        ?.value as DuckDBInstance['connect'];
      watch = watchEngine();
      let calls = 0;
      vi.spyOn(DuckDBInstance.prototype, 'connect').mockImplementation(async function (this: DuckDBInstance) {
        if (++calls === 2) throw new Error('no second connection');
        return connect.call(this);
      });
      await failure(openFixtureSession(fixture));
      expect(watch.counts()).toEqual({
        instances: 1,
        instanceCloses: 1,
        connections: 2,
        connectionCloses: 1,
      });
      vi.restoreAllMocks();

      const empty = await mkdtemp(join(tmpdir(), 'aantje-missing-'));
      cleanups.push(() => rm(empty, { recursive: true, force: true }));
      watch = watchEngine();
      for (const kind of ['sqlite', 'duckdb'] as const) {
        const path = join(empty, `typo.${kind}`);
        const error = await failure(
          openSqlSession({
            access: { profile: { id: 'x', name: 'x', kind, path }, s3: {}, extensionDirectory },
            mode: 'read-write',
          }),
        );
        expect(error.code).toBe('FILE_NOT_FOUND');
        expect(error.userMessage).toContain(path);
      }
      expect(await readdir(empty)).toEqual([]);
      expect(watch.counts().instances).toBe(0);
      vi.restoreAllMocks();

      for (const kind of ['duckdb', 'sqlite'] as const) {
        const notALake = await mkdtemp(join(tmpdir(), 'aantje-notalake-'));
        cleanups.push(() => rm(notALake, { recursive: true, force: true }));
        const path = join(notALake, `customers.${kind}`);
        await withEngine(async (connection) => {
          await connection.run(`ATTACH '${path.replaceAll("'", "''")}' AS plain (TYPE ${kind})`);
          await connection.run("CREATE TABLE plain.customers AS SELECT 1 AS id, 'Ann' AS name");
        });
        const before = await tablesOf(path, kind);
        const profile = { id: 'x', name: 'x', kind, path } as const;
        for (const mode of ['read-write', 'read-only'] as const) {
          const error = await failure(
            openSqlSession({ access: { profile, s3: {}, extensionDirectory }, mode }),
          );
          expect(error.code, `${kind} ${mode}`).toBe('CONNECTION_FAILED');
        }
        expect(before).toEqual(['customers']);
        expect(await tablesOf(path, kind)).toEqual(before);
      }
    });

    it('ends an opening at the abort signal and at its time limits, and releases a DuckDB file at once', async () => {
      const fixture = await copyDataFixture('sqlite');
      cleanups.push(() => fixture.remove());
      let watch = watchEngine();
      const before = await failure(
        openFixtureSession(fixture, 'read-write', { signal: AbortSignal.abort() }),
      );
      expect(before.code).toBe('ABORTED');
      expect(watch.counts().instances).toBe(0);

      const slowInstall = (): void => {
        const run = Object.getOwnPropertyDescriptor(DuckDBConnection.prototype, 'run')
          ?.value as DuckDBConnection['run'];
        vi.spyOn(DuckDBConnection.prototype, 'run').mockImplementation(async function (
          this: DuckDBConnection,
          sql,
          ...rest
        ) {
          if (sql.startsWith('INSTALL ')) await sleep(2500);
          return run.call(this, sql, ...rest);
        });
      };
      slowInstall();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const started = performance.now();
      const during = await failure(openFixtureSession(fixture, 'read-write', { signal: controller.signal }));
      expect(during.code).toBe('ABORTED');
      expect(performance.now() - started).toBeLessThan(2000);
      await vi.waitFor(() => expect(watch.counts()).toEqual(CLOSED), { timeout: 15_000 });

      // The installation of the extensions has a limit of its own.
      const limited = await failure(
        openSqlSession({
          access: accessFor(fixture, { timeoutMs: 60_000, extensionTimeoutMs: 300 }),
          mode: 'read-write',
        }),
      );
      expect(limited.code).toBe('TIMEOUT');
      expect(limited.userMessage).toContain('aantje.duckdb.extensionDirectory');
      // The installation that was given up still ends in the background: let it end before the next count.
      await sleep(3000);
      vi.restoreAllMocks();

      // An attach that takes longer than timeoutMs is cancelled, and the engine is stopped.
      const run = Object.getOwnPropertyDescriptor(DuckDBConnection.prototype, 'run')
        ?.value as DuckDBConnection['run'];
      vi.spyOn(DuckDBConnection.prototype, 'run').mockImplementation(async function (
        this: DuckDBConnection,
        sql,
        ...rest
      ) {
        // An attach that never ends, but that the engine can interrupt.
        return run.call(this, sql.startsWith('ATTACH ') ? LONG_QUERY : sql, ...rest);
      });
      watch = watchEngine();
      const attachStarted = performance.now();
      const timeout = await failure(
        openSqlSession({ access: accessFor(fixture, { timeoutMs: 500 }), mode: 'read-write' }),
      );
      expect(timeout.code).toBe('TIMEOUT');
      expect(performance.now() - attachStarted).toBeLessThan(3000);
      await vi.waitFor(() => expect(watch.counts()).toEqual(CLOSED), { timeout: 5000 });
      vi.restoreAllMocks();

      // A cancel that comes after the file is locked is not reported before the file is released.
      const duckdb = await copyDataFixture('duckdb');
      cleanups.push(() => duckdb.remove());
      const lateController = new AbortController();
      vi.spyOn(DuckDBConnection.prototype, 'run').mockImplementation(async function (
        this: DuckDBConnection,
        sql,
        ...rest
      ) {
        const result = await run.call(this, sql, ...rest);
        if (sql.startsWith('ATTACH ')) {
          lateController.abort();
          await sleep(1500);
        }
        return result;
      });
      watch = watchEngine();
      const late = await failure(openFixtureSession(duckdb, 'read-write', { signal: lateController.signal }));
      expect(late.code).toBe('ABORTED');
      expect(watch.counts()).toEqual(CLOSED);
      vi.restoreAllMocks();
      const again = await openFixtureSession(duckdb);
      cleanups.push(() => again.close());
      expect((await query(again, 'SELECT 1')).rows).toEqual([[1]]);
    }, 60_000);

    it('does not let a time limit of more than a month fire at once, and limits only the attach, not the statements', async () => {
      const fixture = await copyDataFixture('sqlite');
      cleanups.push(() => fixture.remove());
      const month = await openSqlSession({
        access: accessFor(fixture, { timeoutMs: 2 ** 31 + 5 }),
        mode: 'read-write',
      });
      cleanups.push(() => month.close());
      expect((await query(month, 'SELECT 1')).rows).toEqual([[1]]);

      const short = await openSqlSession({
        access: accessFor(fixture, { timeoutMs: 1500 }),
        mode: 'read-write',
      });
      cleanups.push(() => short.close());
      await sleep(1800);
      expect((await query(short, 'SELECT count(*)::INTEGER FROM range(3000000)')).rows).toEqual([
        [3_000_000],
      ]);
    }, 30_000);
  });

  describe('files that cannot be written', () => {
    it('reports a read-only SQLite file and a data path that cannot be created, and still reads', async () => {
      if (process.getuid?.() !== 0) {
        const fixture = await copyDataFixture('sqlite');
        cleanups.push(async () => {
          await chmod(fixture.profile.path, 0o666);
          await fixture.remove();
        });
        await chmod(fixture.profile.path, 0o444);
        const session = await openFixtureSession(fixture);
        cleanups.push(() => session.close());

        expect(only(await events(session, 'CREATE TABLE denied (a INTEGER)'), 'error')).toHaveLength(1);
        expect((await query(session, 'SELECT count(*)::INTEGER FROM sales.orders')).rows).toEqual([[2]]);
      }

      const directory = await mkdtemp(join(tmpdir(), 'aantje-blocker-'));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const blocker = join(directory, 'blocker');
      await writeFile(blocker, '');
      const fixture = await copyDataFixture(
        'sqlite',
        `${blocker.split(String.fromCharCode(92)).join('/')}/sub/`,
      );
      cleanups.push(() => fixture.remove());
      const session = await openFixtureSession(fixture);
      cleanups.push(() => session.close());

      const list = await events(
        session,
        'CREATE TABLE d (a INTEGER); INSERT INTO d SELECT range FROM range(100)',
      );

      const [error] = only(list, 'error');
      expect(error?.index).toBe(1);
      expect(error?.message).toContain('blocker');
      expect(session.inTransaction).toBe('none');
    });
  });

  describe('a DuckDB file catalog', () => {
    it('is locked exclusively by a writable session, and lets several read-only sessions and the Explorer share the file', async () => {
      const fixture = await copyDataFixture('duckdb');
      cleanups.push(() => fixture.remove());
      const first = await openFixtureSession(fixture);
      cleanups.push(() => first.close());

      // Two DuckDB instances of one process conflict on a file lock only on Windows; elsewhere the lock works between
      // processes, which the end-to-end suite proves (a writer is refused while aantje is connected).
      if (process.platform === 'win32') {
        const second = await failure(openFixtureSession(fixture));
        const explorer = await failure(openDuckdb({ path: fixture.profile.path }));
        const secondReadOnly = await failure(openFixtureSession(fixture, 'read-only'));
        expect([second.code, explorer.code, secondReadOnly.code]).toEqual(['LOCKED', 'LOCKED', 'LOCKED']);
      }
      await first.close();
      const after = await openDuckdb({ path: fixture.profile.path });
      await after.close();

      const readOnlyFirst = await openFixtureSession(fixture, 'read-only');
      cleanups.push(() => readOnlyFirst.close());
      const readOnlySecond = await openFixtureSession(fixture, 'read-only');
      cleanups.push(() => readOnlySecond.close());
      const reader = await openReader(fixture);
      expect((await query(readOnlyFirst, 'SELECT count(*)::INTEGER FROM sales.orders')).rows).toEqual([[2]]);
      expect((await query(readOnlySecond, 'SELECT count(*)::INTEGER FROM sales.orders')).rows).toEqual([[2]]);
      expect((await reader.snapshots())[0]?.id).toBe(13);
      await reader.close();
    });
  });

  describe('secrets', () => {
    const CANARY_KEY = 'AKIACANARYKEYID';
    const CANARY_SECRET = 'canary/secret+key=value';
    let server: Server;
    let endpoint: string;
    beforeAll(async () => {
      server = createServer((_request, response) => {
        response.statusCode = 403;
        response.end('<Error><Code>AccessDenied</Code></Error>');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it('shows neither the key nor the secret in an object store error, in a quoted statement error or in an opening error', async () => {
      const fixture = await copyDataFixture('sqlite', 's3://aantje-test/');
      cleanups.push(() => fixture.remove());
      const access = accessFor(fixture, {
        s3: { endpoint, urlStyle: 'path' },
        s3Credentials: { keyId: CANARY_KEY, secretKey: CANARY_SECRET },
      });
      const remote = await openSqlSession({ access, mode: 'read-write' });
      cleanups.push(() => remote.close());

      const list = await events(
        remote,
        'CREATE TABLE remote (a INTEGER); INSERT INTO remote SELECT range FROM range(100)',
      );
      const read = await events(remote, 'SELECT * FROM sales.orders');

      expect(only(list, 'error')[0]?.message).toContain('HTTP 403');
      expect(only(read, 'error')[0]?.message).toContain('HTTP 403');
      expect(JSON.stringify([list, read])).not.toMatch(
        new RegExp(`${CANARY_KEY}|${CANARY_SECRET.replace(/[+/]/g, '.')}`),
      );

      // The engine quotes the path of a missing Parquet file, which holds the directory name: use it as key id.
      const quoting = await copyDataFixture('sqlite');
      cleanups.push(() => quoting.remove());
      const files = join(quoting.directory, 'sqlite-files', 'sales', 'orders');
      for (const name of await readdir(files)) await rm(join(files, name));
      const keyId = basename(quoting.directory);
      const session = await openSqlSession({
        access: accessFor(quoting, { s3Credentials: { keyId, secretKey: 'canary-secret-key' } }),
        mode: 'read-write',
      });
      cleanups.push(() => session.close());
      const plainSession = await openFixtureSession(quoting);
      const plainList = await events(plainSession, 'SELECT * FROM sales.orders');
      await plainSession.close();
      const scrubbed = await events(session, 'SELECT * FROM sales.orders');
      expect(only(plainList, 'error')[0]?.message).toContain(keyId);
      expect(only(scrubbed, 'error')[0]?.message).toContain('***');
      expect(JSON.stringify(scrubbed)).not.toContain(keyId);

      // DuckDB quotes the path of the catalog file in the error of a session that cannot be opened.
      const broken = await copyDataFixture('duckdb');
      cleanups.push(() => broken.remove());
      const brokenKey = basename(broken.directory);
      await writeFile(broken.profile.path, 'not a database');
      const error = await failure(
        openSqlSession({
          access: accessFor(broken, { s3Credentials: { keyId: brokenKey, secretKey: 'canary-secret-key' } }),
          mode: 'read-write',
        }),
      );
      for (const text of [error.userMessage, (error.cause as Error).message]) {
        expect(text).not.toContain(brokenKey);
        expect(text).toContain('***');
      }
    });
  });
});

describe.skipIf(skipReason)('lakes created in place', () => {
  it('give a result the types of the grid preview, and open without the schema main with the first schema as the default', async () => {
    const lake = await createLake([
      'CREATE TABLE types (a BIGINT, b UBIGINT, c DOUBLE, d DATE, e BOOLEAN, f VARCHAR, g VARCHAR[], i STRUCT(x INTEGER, y STRUCT(z VARCHAR[])), j TIME, l HUGEINT, o DECIMAL(18,3)[], p INTERVAL, q MAP(VARCHAR, INTEGER))',
      "INSERT INTO types VALUES (9007199254740993, 18446744073709551615, 1.5, DATE '2026-01-02', true, 'Zoë \"q\" ''s''', ['a', 'b'], {'x': 1, 'y': {'z': ['p']}}, TIME '01:02:03', 18446744073709551616, [1.25], INTERVAL 3 DAY, MAP {'k': 1})",
      "INSERT INTO types VALUES (NULL, NULL, NULL, NULL, false, '', [], NULL, NULL, NULL, NULL, NULL, NULL)",
    ]);
    const access = { profile: lake.profile, s3: {}, extensionDirectory };
    try {
      const preview = await previewTable(access, { schema: 'main', table: 'types' });
      const session = await openSqlSession({ access, mode: 'read-only' });
      try {
        const result = await query(session, 'SELECT * FROM types');

        expect(result.columns).toEqual(preview.columns);
        expect(result.rows).toEqual(preview.rows);
        expect(result.rows[0]?.slice(0, 2)).toEqual(['9007199254740993', '18446744073709551615']);
        expect(result.columns.map(({ kind }) => kind)).toContain('nested');
      } finally {
        await session.close();
      }
    } finally {
      await lake.remove();
    }

    const noMain = await createLake([
      'CREATE SCHEMA zeta',
      'CREATE SCHEMA alpha',
      'CREATE TABLE alpha.t (a INTEGER)',
      'INSERT INTO alpha.t VALUES (7)',
      'DROP SCHEMA main',
    ]);
    const noMainAccess = { profile: noMain.profile, s3: {}, extensionDirectory };
    try {
      const readOnly = await openSqlSession({ access: noMainAccess, mode: 'read-only' });
      try {
        expect((await query(readOnly, 'SELECT a FROM t')).rows).toEqual([[7]]);
        expect((await query(readOnly, 'SELECT current_schema()')).rows).toEqual([['alpha']]);
        // The functions behind the lake's name resolve in the default schema, so the editor's offers still run.
        expect(
          (
            await query(
              readOnly,
              "SELECT (SELECT max(snapshot_id) FROM lake.snapshots()) = (SELECT max(snapshot_id) FROM ducklake_snapshots('lake'))",
            )
          ).rows,
        ).toEqual([[true]]);
      } finally {
        await readOnly.close();
      }
      const session = await openSqlSession({ access: noMainAccess, mode: 'read-write' });
      try {
        await events(session, 'CREATE TABLE u (b INTEGER)');
        expect(
          (await query(session, "SELECT schema_name FROM duckdb_tables() WHERE table_name = 'u'")).rows,
        ).toEqual([['alpha']]);
      } finally {
        await session.close();
      }
    } finally {
      await noMain.remove();
    }

    const empty = await createLake(['DROP SCHEMA main']);
    try {
      await expect(
        openSqlSession({ access: { profile: empty.profile, s3: {}, extensionDirectory }, mode: 'read-only' }),
      ).rejects.toBeInstanceOf(AantjeError);
    } finally {
      await empty.remove();
    }
  });
});
