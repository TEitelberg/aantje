import { describe, expect, it } from 'vitest';
import { translateSqlError } from '../../src/sql/errors';
import type { SqlErrorContext } from '../../src/sql/errors';

const writable: SqlErrorContext = { mode: 'read-write', kind: 'sqlite' };
const readOnly: SqlErrorContext = { mode: 'read-only', kind: 'sqlite' };
const duckdb: SqlErrorContext = { mode: 'read-write', kind: 'duckdb' };
const postgres: SqlErrorContext = { mode: 'read-write', kind: 'postgres' };

// The texts are those that DuckDB 2.0.0 with DuckLake gave, to the letter, as in sql-session.test.ts and
// sql-postgres.test.ts.
const READ_ONLY_TEXT =
  'Invalid Input Error: Cannot execute statement of type "CREATE" on database "lake" which is attached in read-only mode!';
const COMMIT_READONLY_TEXT =
  'TransactionContext Error: Failed to commit: Failed to commit DuckLake transaction.\nCannot append to a readonly database.';
const ABORTED_TEXT = 'TransactionContext Error: Current transaction is aborted (please ROLLBACK)';
const CONFLICT_TEXT =
  'TransactionContext Error: Failed to commit: Failed to commit DuckLake transaction.\nTransaction conflict - attempting to alter table with index "1" - but another transaction has altered it';
const SQLITE_READONLY_TEXT =
  'TransactionContext Error: Failed to commit: Failed to commit DuckLake transaction.\nFailed to flush changes into DuckLake: attempt to write a readonly database';
const SQLITE_LOCKED_TEXT =
  'TransactionContext Error: Failed to commit: Failed to commit DuckLake transaction.\nFailed to flush changes into DuckLake: database is locked';
const DENIED_TEXT =
  'TransactionContext Error: Failed to commit: Failed to commit DuckLake transaction.\nFailed to flush changes into DuckLake: Failed to execute query "SET LOCAL extra_float_digits = 3;INSERT INTO "meta".ducklake_snapshot VALUES (2, NOW(), 2, 3, 0);INSERT INTO "meta".ducklake_inlined_data_1_1 VALUES (0, 2, NULL, \'hunter2-value\')": ERROR:  permission denied for table ducklake_snapshot\n';
const DIRECTORY_TEXT =
  'IO Error: Failed to create directory "C:\\data\\main\\d": The system cannot find the path specified.\r\n';
const LOCK_WINDOWS_TEXT =
  'IO Error: Failed to attach DuckLake MetaData "__ducklake_metadata_lake" at path + "C:\\x\\catalog.duckdb"Cannot open file "C:\\x\\catalog.duckdb": The process cannot access the file because it is being used by another process.';
const LOCK_LINUX_TEXT =
  'IO Error: Could not set lock on file "/x/catalog.duckdb": Conflicting lock is held in /usr/bin/node (PID 41) by user app. See also https://duckdb.org/docs/connect/concurrency';
const PASSWORD_TEXT =
  'IO Error: Failed to attach DuckLake MetaData "__ducklake_metadata_lake" at path + "postgres:"Unable to connect to Postgres at "": connection to server at "127.0.0.1", port 5432 failed: FATAL:  password authentication failed for user "aantje"\n';
const S3_WRITE_TEXT =
  "HTTP Error: HTTP PUT error uploading to 's3://bucket/main/s/ducklake-1.parquet' (HTTP 403 Forbidden)\n\nAccessDenied\n\nAuthentication Failure - this is usually caused by invalid or missing credentials.\n* Credentials are provided, but they did not work.";
const NO_DATA_PATH_TEXT =
  'Invalid Input Error: Failed to attach DuckLake MetaData: data_path is not set and the catalog does not exist';
const NOT_A_LAKE_TEXT =
  'Invalid Input Error: Existing DuckLake at metadata catalog "C:/x/customers.duckdb" does not exist - and creating a new DuckLake is explicitly disabled';
const S3_MISSING_FILE =
  's3://example-lake/ducklake/demo/events2/ducklake-01a18d9f-ad0f-7bae-b603-0d920e183c68.parquet';
const S3_MISSING_TEXT = `HTTP Error: HTTP GET error reading '${S3_MISSING_FILE}' (HTTP 404 Not Found)\n\nNoSuchKey: The specified key does not exist.`;
const LOCAL_MISSING_FILE = String.raw`C:\lakes\shop\sqlite-files\shop\log\ducklake-1.parquet`;
const LOCAL_MISSING_TEXT = `IO Error: Cannot open file "${LOCAL_MISSING_FILE}": The system cannot find the file specified.`;

describe('translateSqlError', () => {
  it.each<[string, string, SqlErrorContext, string, RegExp]>([
    ['a write in a read-only session', READ_ONLY_TEXT, readOnly, 'QUERY_FAILED', /read-only session/],
    [
      'a write to the metadata database of a read-only session',
      READ_ONLY_TEXT.replace('"lake"', '"__ducklake_metadata_lake"'),
      readOnly,
      'QUERY_FAILED',
      /read-only session/,
    ],
    [
      'a maintenance call that fails at the commit of a read-only session',
      COMMIT_READONLY_TEXT,
      readOnly,
      'QUERY_FAILED',
      /read-only session/,
    ],
    [
      'the lake attached read-only in a writable session (the switch is not to blame)',
      READ_ONLY_TEXT,
      writable,
      'QUERY_FAILED',
      /^(?!.*read-only session).*"lake".*read-only/,
    ],
    [
      'another database attached read-only',
      READ_ONLY_TEXT.replace('"lake"', '"archive"'),
      writable,
      'QUERY_FAILED',
      /"archive"/,
    ],
    ['an aborted transaction', ABORTED_TEXT, writable, 'QUERY_FAILED', /ROLLBACK/],
    ['a transaction conflict', CONFLICT_TEXT, writable, 'QUERY_FAILED', /^(?!.*index "1").*again/],
    ['a locked SQLite catalog', SQLITE_LOCKED_TEXT, writable, 'LOCKED', /again/],
    [
      'a SQLite file the user may not write',
      SQLITE_READONLY_TEXT,
      writable,
      'QUERY_FAILED',
      /SQLite.*read-only/,
    ],
    [
      'a directory of the data path that cannot be created',
      DIRECTORY_TEXT,
      writable,
      'QUERY_FAILED',
      /"C:\\data\\main\\d"/,
    ],
    ['a DuckDB file locked, Windows wording, writable', LOCK_WINDOWS_TEXT, duckdb, 'LOCKED', /exclusively/],
    ['a DuckDB file locked, Linux wording, writable', LOCK_LINUX_TEXT, duckdb, 'LOCKED', /exclusively/],
    [
      'a DuckDB file locked, read-only session',
      LOCK_LINUX_TEXT,
      { ...duckdb, mode: 'read-only' },
      'LOCKED',
      /^(?!.*exclusively).*locked for writing/,
    ],
    ['a lock on a file of a SQLite catalog', LOCK_LINUX_TEXT, writable, 'LOCKED', /another process/],
    ['a rejected PostgreSQL password', PASSWORD_TEXT, postgres, 'AUTH_FAILED', /PostgreSQL/],
    ['a refused object store', S3_WRITE_TEXT, writable, 'AUTH_FAILED', /^(?!.*s3:\/\/).*HTTP 403/],
    ['a catalog without a data path', NO_DATA_PATH_TEXT, postgres, 'CONNECTION_FAILED', /never creates/],
    ['a file that holds no DuckLake', NOT_A_LAKE_TEXT, writable, 'CONNECTION_FAILED', /never creates/],
  ])('maps %s to its code and advice', (_, text, context, code, advice) => {
    const translated = translateSqlError(text, context);

    expect(translated.code).toBe(code);
    expect(translated.message).toMatch(advice);
  });

  it('keeps only the table of a PostgreSQL permission error, never the SQL or the values in it', () => {
    const { code, message } = translateSqlError(DENIED_TEXT, postgres);

    expect(code).toBe('QUERY_FAILED');
    expect(message).toContain('permission denied for table ducklake_snapshot');
    expect(message).not.toMatch(/INSERT|hunter2|extra_float_digits|"meta"/);
    const variants: [string, string][] = [
      ['permission denied for schema meta', 'schema meta'],
      ['ERROR:  permission denied for table "ducklake_snapshot"', 'table "ducklake_snapshot"'],
      ['ERROR:  Permission denied for TABLE ducklake_snapshot', 'table ducklake_snapshot'],
    ];
    for (const [text, named] of variants) {
      expect(translateSqlError(text, postgres).message, text).toContain(`permission denied for ${named}`);
    }
  });

  it('recognises the bare engine fragments of a lock, a rejected login and a refused object store', () => {
    const rows: [string, SqlErrorContext, string][] = [
      ['Could not set lock on file "/x/catalog.duckdb"', duckdb, 'LOCKED'],
      ['Conflicting lock is held in /usr/bin/node (PID 41)', writable, 'LOCKED'],
      ['the process cannot access the file because it is being used by another process', duckdb, 'LOCKED'],
      ['FATAL:  Password authentication FAILED for user "aantje"', postgres, 'AUTH_FAILED'],
      ['fe_sendauth: no password was provided', postgres, 'AUTH_FAILED'],
      ['SCRAM authentication failed for user "aantje"', postgres, 'AUTH_FAILED'],
      ["HTTP Error: HTTP GET error on 's3://bucket/x.parquet' (HTTP 403 Forbidden)", writable, 'AUTH_FAILED'],
      [
        "HTTP Error: HTTP HEAD error on 's3://bucket/x.parquet' (HTTP 403 Forbidden)",
        writable,
        'AUTH_FAILED',
      ],
    ];
    for (const [text, context, code] of rows) {
      expect(translateSqlError(text, context).code, text).toBe(code);
    }
  });

  it('names a data file of the catalog that the object store or the disk does not have, with its path', () => {
    const remote = translateSqlError(S3_MISSING_TEXT, {
      ...writable,
      dataPath: 's3://example-lake/ducklake/',
    });
    expect(remote.code).toBe('QUERY_FAILED');
    expect(remote.message).toContain(`the catalog lists the data file ${S3_MISSING_FILE}`);
    expect(remote.message).toContain('HTTP 404');
    expect(remote.message).toContain('AT (VERSION => ...)');

    const local = translateSqlError(LOCAL_MISSING_TEXT, {
      ...writable,
      dataPath: 'C:/lakes/shop/sqlite-files/',
    });
    expect(local.code).toBe('QUERY_FAILED');
    expect(local.message).toContain(`the catalog lists the data file ${LOCAL_MISSING_FILE}`);
    expect(local.message).toContain('does not exist on this machine');
    expect(local.message).toContain('AT (VERSION => ...)');
  });

  it('does not say that the catalog lists a file outside the data path, or when the data path is not known', () => {
    const local = 'IO Error: Cannot open file "/data/own.parquet": No such file or directory';
    const remote =
      "HTTP Error: HTTP GET error reading 'http://127.0.0.1:9000/my/own.parquet' (HTTP 404 Not Found)";

    for (const context of [{ ...writable, dataPath: '/lake/files/' }, writable]) {
      expect(translateSqlError(local, context).message).toMatch(/^(?!.*catalog lists).*\/data\/own\.parquet/);
      expect(translateSqlError(remote, context).message).toMatch(
        /^(?!.*catalog lists).*HTTP 404.*http:\/\/127\.0\.0\.1:9000\/my\/own\.parquet/,
      );
    }
  });

  it('leaves other IO errors and a 404 of an upload as the engine words them, cut to the first line', () => {
    const denied = 'IO Error: Cannot open file "/lake/a.parquet": Permission denied';
    const upload =
      "HTTP Error: HTTP PUT error uploading to 's3://nosuchbucket/main/s/ducklake-1.parquet' (HTTP 404 Not Found)";

    expect(translateSqlError(denied, writable).message).toBe(denied);
    expect(translateSqlError(`${upload}\n\nNoSuchBucket`, writable).message).toBe(upload);
    expect(translateSqlError(COMMIT_READONLY_TEXT, writable).message).toBe(
      'TransactionContext Error: Failed to commit: Failed to commit DuckLake transaction.',
    );
  });

  it('reduces an unknown error to its first line, whichever the line break', () => {
    expect(
      translateSqlError(
        'Catalog Error: Table with name nope does not exist!\nDid you mean "pg_indexes"?\n\nLINE 1: SELECT',
        writable,
      ),
    ).toEqual({ code: 'QUERY_FAILED', message: 'Catalog Error: Table with name nope does not exist!' });
    expect(translateSqlError('Binder Error: no line break\r\nsecond line', writable).message).toBe(
      'Binder Error: no line break',
    );
  });
});

describe('translateSqlError on a Quack catalog', () => {
  const quack: SqlErrorContext = { mode: 'read-write', kind: 'quack' };

  it('reports a refused token, a statement the server refuses and a restarted server, which the open session cannot recover from', () => {
    expect(translateSqlError('Invalid Input Error: Authentication failed', quack).code).toBe('AUTH_FAILED');
    expect(translateSqlError('Invalid Input Error: Authorization failed', quack).code).toBe('QUERY_FAILED');
    const restart = translateSqlError('Invalid Input Error: Invalid connection id', quack);
    expect(restart.code).toBe('CONNECTION_FAILED');
    expect(restart.message).not.toBe(
      translateSqlError('Invalid Input Error: Invalid connection id', postgres).message,
    );
  });
});
