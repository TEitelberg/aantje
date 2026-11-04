import { describe, expect, it } from 'vitest';
import { newestSnapshotQuery } from '../../src/data/attach';
import { catalogFacts } from '../../src/data/engine';
import { dataError, isCatalogFile, MISSING_LOCAL_FILE } from '../../src/data/errors';
import type { DataAccess } from '../../src/data/types';
import { maskSecrets as scrub } from '../../src/secrets';

const table = { schema: 'sales', table: 'orders' };
const access: DataAccess = {
  profile: { id: 'p', name: 'p', kind: 'postgres', host: 'h', port: 5432, database: 'd', user: 'u' },
  password: "pa'ss",
  s3: {},
  s3Credentials: { keyId: 'AKIAKEY', secretKey: 'sEcReT/key' },
};

// The masking that every engine message goes through (`maskSecrets`, shared with the logger).
describe('maskSecrets', () => {
  it('replaces every secret everywhere: plain, inside a SQL literal, URL-encoded, JSON-escaped, the longer one first; ignores empty and one- or two-character secrets', () => {
    const jsonSecret = 'pa"ss\\key';
    const json = JSON.stringify({ error: `rejected ${jsonSecret}` });
    expect(json).not.toContain(jsonSecret);

    const table: [string, string, readonly string[], string][] = [
      ['every occurrence of every secret', 'a pwd b pwd c KEY', ['pwd', 'KEY'], 'a *** b *** c ***'],
      ['a SQL string literal', "PASSWORD 'pa''ss' failed", ["pa'ss"], "PASSWORD '***' failed"],
      ['a URL-encoded form', 'postgres://u:se%2Fcret%23@db/lake', ['se/cret#'], 'postgres://u:***@db/lake'],
      ['a JSON-escaped form', json, [jsonSecret], '{"error":"rejected ***"}'],
      ['the longer secret first', 'key=abcdef', ['abc', 'abcdef'], 'key=***'],
      ['an empty secret', 'unchanged', [''], 'unchanged'],
      ['a one- or two-character secret', 'a short ab secret', ['a', 'ab'], 'a short ab secret'],
      ['the shortest secret it accepts', 'pw=xyz, not xy', ['xyz'], 'pw=***, not xy'],
    ];
    for (const [name, text, secrets, expected] of table) {
      expect(scrub(text, secrets), name).toBe(expected);
    }
  });
});

describe('dataError', () => {
  it('never lets the password or the S3 keys reach the message or the cause, also a secret with a line break, and keeps only the first line', () => {
    const raw = new Error(
      "Parser Error: near \"pa'ss\": CREATE SECRET (PASSWORD 'pa''ss', KEY_ID 'AKIAKEY', SECRET 'sEcReT/key')\nLINE 1: second line",
    );
    for (const phase of ['extension', 'setup', 'query'] as const) {
      const error = dataError(raw, phase, access, table);
      for (const text of [error.userMessage, (error.cause as Error).message]) {
        expect(text, phase).not.toMatch(/pa'ss|pa''ss|AKIAKEY|sEcReT\/key/);
        expect(text, phase).toContain('***');
        expect(text, phase).not.toContain('second line');
      }
    }

    const multiline: DataAccess = { ...access, password: 'pa\nss word' };
    const error = dataError(new Error('Failure for pa\nss word here'), 'query', multiline, table);
    expect(error.userMessage).toContain('Failure for *** here');
    expect(error.userMessage).not.toContain('ss word');
    expect((error.cause as Error).message).toBe('Failure for *** here');
  });

  it('maps a failure to its code and advice: a missing extension names the directory setting, a rejected login is AUTH_FAILED, a failed file read names the S3 settings and the credentials command, another DuckLake version is explained without AUTOMATIC_MIGRATION', () => {
    const cases: [
      string,
      string,
      'extension' | 'setup' | 'query',
      string,
      readonly string[],
      readonly string[],
    ][] = [
      [
        'a missing extension',
        'IO Error: Failed to download extension "ducklake"',
        'extension',
        'CONNECTION_FAILED',
        ['aantje.duckdb.extensionDirectory'],
        [],
      ],
      ['a rejected login', 'password authentication failed for user "u"', 'setup', 'AUTH_FAILED', [], []],
      [
        'a refused file read',
        'HTTP Error: HTTP GET error on ... (HTTP 403)',
        'query',
        'QUERY_FAILED',
        ['"sales.orders"', 'aantje.s3.*', 'aantje: Set S3 Credentials...'],
        [],
      ],
      [
        'a failure that has nothing to do with files',
        'Catalog Error: Table with name orders does not exist',
        'query',
        'QUERY_FAILED',
        ['"sales.orders"'],
        ['S3'],
      ],
      [
        'a catalog version mismatch',
        'Invalid Input Error: DuckLake catalog version mismatch: catalog version is 0.3, but the extension requires version 1.1. To automatically migrate, set AUTOMATIC_MIGRATION to TRUE when attaching.',
        'setup',
        'CONNECTION_FAILED',
        ['catalog version is 0.3, but the extension requires version 1.1.', 'read-only and cannot migrate'],
        ['AUTOMATIC_MIGRATION'],
      ],
      [
        'an unsupported ducklake_version',
        "Invalid Input Error: Unsupported ducklake_version '9.9'",
        'setup',
        'CONNECTION_FAILED',
        ["Unsupported ducklake_version '9.9'", 'read-only and cannot migrate'],
        [],
      ],
    ];
    for (const [name, raw, phase, code, contains, lacks] of cases) {
      const error = dataError(new Error(raw), phase, access, table);
      expect(error.code, name).toBe(code);
      for (const text of contains) expect(error.userMessage, name).toContain(text);
      for (const text of lacks) expect(error.userMessage, name).not.toContain(text);
    }
  });

  // The texts DuckDB 2.0.0 gave for RustFS 1.0.4 to the letter.
  const FILE =
    's3://example-lake/ducklake/demo/events2/ducklake-01a18d9f-ad0f-7bae-b603-0d920e183c68.parquet';
  const GONE = `HTTP Error: HTTP GET error reading '${FILE}' (HTTP 404 Not Found)\n\nNoSuchKey: The specified key does not exist.`;
  const listed = { dataPath: 's3://example-lake/ducklake/' };

  it('explains a data file that the catalog lists and the store does not have, and keeps the first line as the cause', () => {
    const error = dataError(new Error(GONE), 'query', access, { schema: 'demo', table: 'events2' }, listed);

    expect(error.code).toBe('QUERY_FAILED');
    // The table, the file the catalog lists, the answer of the store and the setting to check; no snapshot advice.
    for (const part of [
      '"demo.events2"',
      `the catalog lists the data file ${FILE}`,
      'HTTP 404 (NoSuchKey',
      'aantje.s3.endpoint',
    ]) {
      expect(error.userMessage).toContain(part);
    }
    expect(error.userMessage).not.toContain('snapshot @');
    expect((error.cause as Error).message).toBe(GONE.split('\n')[0]);
  });

  it('adds the snapshot of a pinned read: older than the newest (with the older-snapshot cause), the newest itself, or one whose newest is unknown', () => {
    const pinned = (snapshot: number, newest?: number) =>
      dataError(new Error(GONE), 'query', { ...access, snapshot }, table, { ...listed, newest }).userMessage;

    expect(pinned(3, 7)).toContain('an older snapshot still lists a file');
    expect(pinned(3, 7)).toMatch(/snapshot @3, the newest is @7.*Show Latest Snapshot\.$/);
    expect(pinned(7, 7)).not.toContain('an older snapshot');
    expect(pinned(7, 7)).toMatch(/the newest snapshot @7, so a newer snapshot will not help\.$/);
    expect(pinned(3)).toMatch(/an older snapshot still lists.*snapshot @3\.$/);
  });

  it('words a missing bucket, a server without an S3 error code and a HEAD request, keeps the text of a refused request, and does not say "the catalog lists" for a url outside the data path', () => {
    const variants: [string, string, string][] = [
      [
        'a missing bucket',
        GONE.replace('NoSuchKey: The specified key', 'NoSuchBucket: The specified bucket'),
        'HTTP 404 (NoSuchBucket: the bucket does not exist).',
      ],
      [
        'a server without an S3 error code',
        `${GONE.split('\n')[0]}\n\n<html>404 page not found</html>`,
        'HTTP 404. Likely causes',
      ],
      [
        'a HEAD request',
        `HTTP Error: HTTP HEAD error checking '${FILE}' (HTTP 404 Not Found)\n\nLINE 1: SELECT * FROM read_parquet('${FILE}')`,
        'HTTP 404. Likely causes',
      ],
    ];
    for (const [name, raw, expected] of variants) {
      expect(dataError(new Error(raw), 'query', access, table, listed).userMessage, name).toContain(expected);
    }

    const forbidden = `HTTP Error: HTTP GET error reading '${FILE}' (HTTP 403 Forbidden)\n\nAccessDenied: Access Denied`;
    const refused = dataError(new Error(forbidden), 'query', access, table).userMessage;
    expect(refused).toContain(`'${FILE}' (HTTP 403 Forbidden)`);
    expect(refused).toContain('aantje.s3.*');
    expect(refused).not.toContain('the catalog lists');

    const foreign = 'http://127.0.0.1:9000/my/own.parquet';
    const raw = `HTTP Error: HTTP GET error reading '${foreign}' (HTTP 404 Not Found)`;
    const own = dataError(new Error(raw), 'query', access, table, listed).userMessage;
    expect(own).toContain(foreign);
    expect(own).toContain('HTTP 404');
    expect(own).not.toMatch(/the catalog lists|aantje\.s3/);
    expect(dataError(new Error(raw), 'query', access, table).userMessage).toBe(own);
  });

  it('keeps a key id and a secret that are part of the url out of the message', () => {
    const named: DataAccess = { ...access, s3Credentials: { keyId: 'example-lake', secretKey: 'events2' } };
    const error = dataError(new Error(GONE), 'query', named, table);

    expect(error.userMessage).toContain('s3://***/ducklake/demo/***/ducklake-');
    expect(error.userMessage).not.toMatch(/example-lake|events2/);
  });
});

describe('a data file that is not on the local disk', () => {
  // The texts DuckDB 2.0.0 gave on Windows and on Linux for a Parquet file that was deleted, to the letter.
  const WINDOWS_FILE = String.raw`C:\lakes\shop\sqlite-files\sales\orders\ducklake-01a18c33-cfcb-7cc1-bfe9-dfce5e8d67c6.parquet`;
  const LINUX_FILE = '/home/coder/project/history/sqlite-files/shop/log/ducklake-01a18c33-cfcb-7cc1.parquet';
  const WINDOWS = `IO Error: Cannot open file "${WINDOWS_FILE}": The system cannot find the file specified.`;
  const LINUX = `IO Error: Cannot open file "${LINUX_FILE}": No such file or directory`;
  const CAUSES =
    'the file was removed or moved (a manual delete, a cleanup of the folder, a disk or share that is not mounted); the data_path of the catalog was changed or points to another folder than the one the lake was written to; the lake lives on another machine and only the catalog was copied here.';

  it('is explained on Windows (with no word about S3) and on Linux and macOS with the answer of that system', () => {
    const windows = dataError(new Error(WINDOWS), 'query', access, table, {
      dataPath: 'C:/lakes/shop/sqlite-files/',
    });
    expect(windows.code).toBe('QUERY_FAILED');
    for (const part of [
      '"sales.orders"',
      `the catalog lists the data file ${WINDOWS_FILE}`,
      '(The system cannot find the file specified)',
      CAUSES,
    ]) {
      expect(windows.userMessage).toContain(part);
    }
    expect(windows.userMessage).not.toMatch(/S3|aantje\.s3/);
    expect((windows.cause as Error).message).toBe(WINDOWS);

    const linux = dataError(new Error(LINUX), 'query', access, table, {
      dataPath: '/home/coder/project/history/sqlite-files/',
    }).userMessage;
    expect(linux).toContain(
      `the catalog lists the data file ${LINUX_FILE}, but it does not exist on this machine (No such file or directory)`,
    );
    expect(linux).toContain(CAUSES);
    expect(linux).not.toMatch(/S3|aantje\.s3/);
  });

  it('only says what is missing when the folder is gone too, when the data path is unknown or the file lies elsewhere; leaves other file errors with the generic advice; adds the snapshot like a 404 does', () => {
    // The file and the answer of the system, but no cause that the catalog would explain.
    const onlyMissing = (message: string, file: string, answer: string): void => {
      expect(message).toContain(file);
      expect(message).toContain(answer);
      expect(message).not.toMatch(/the catalog lists|Likely causes|aantje\.s3/);
    };
    const folderGone = WINDOWS.replace('file specified', 'path specified');
    onlyMissing(
      dataError(new Error(folderGone), 'query', access, table).userMessage,
      WINDOWS_FILE,
      '(The system cannot find the path specified)',
    );

    const answered = dataError(new Error(LINUX), 'query', access, table).userMessage;
    onlyMissing(answered, LINUX_FILE, '(No such file or directory)');
    expect(dataError(new Error(LINUX), 'query', access, table, { dataPath: '/mnt/other/' }).userMessage).toBe(
      answered,
    );

    const denied = `IO Error: Cannot open file "${LINUX_FILE}": Permission denied`;
    const kept = dataError(new Error(denied), 'query', access, table).userMessage;
    expect(kept).toContain(denied);
    expect(kept).toContain('aantje.s3.*');
    expect(kept).not.toContain('does not exist on this machine');

    const facts = { dataPath: '/home/coder/project/history/sqlite-files/', newest: 56 };
    const older = dataError(new Error(LINUX), 'query', { ...access, snapshot: 5 }, table, facts).userMessage;
    const newest = dataError(
      new Error(LINUX),
      'query',
      { ...access, snapshot: 56 },
      table,
      facts,
    ).userMessage;
    expect(older).toContain('an older snapshot still lists a file');
    expect(older).toMatch(/snapshot @5, the newest is @56/);
    expect(newest).toMatch(/the newest snapshot @56, so a newer snapshot will not help\.$/);
  });
});

describe('what the engine asks the catalog after a 404', () => {
  const rows = (value: unknown) => ({ getRowsJson: () => [[value]] });
  const answering = (answers: { newest?: unknown; dataPath?: unknown }) => ({
    runAndReadAll: (sql: string) => {
      const answer = sql === newestSnapshotQuery() ? answers.newest : answers.dataPath;
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(rows(answer));
    },
  });

  it('reads the newest snapshot of a pinned read (not of an unpinned one) and the data path, scrubs a secret out of the path, and says less instead of failing when the catalog cannot answer', async () => {
    expect(
      await catalogFacts(answering({ newest: '13', dataPath: 's3://example-lake/ducklake/' }) as never, {
        ...access,
        snapshot: 5,
        s3Credentials: { keyId: 'example-lake', secretKey: 'topsecret' },
      }),
    ).toEqual({ newest: 13, dataPath: 's3://***/ducklake/' });
    expect(await catalogFacts(answering({ newest: '13', dataPath: 's3://b/' }) as never, access)).toEqual({
      dataPath: 's3://b/',
    });

    const broken = new Error('catalog gone');
    const pinned = { ...access, snapshot: 5 };
    expect(await catalogFacts(answering({ newest: broken, dataPath: 's3://b/' }) as never, pinned)).toEqual({
      dataPath: 's3://b/',
    });
    expect(await catalogFacts(answering({ newest: '13', dataPath: broken }) as never, pinned)).toEqual({
      newest: 13,
    });
    expect(await catalogFacts(answering({ newest: null, dataPath: null }) as never, pinned)).toEqual({});
  });
});

describe('the messages of a Quack server', () => {
  // The texts that DuckDB 2.0.0 gave in the spike before the Quack support, as the engine and the explorer driver see them.
  const quack: DataAccess = {
    profile: { id: 'q', name: 'q', kind: 'quack', host: 'duckdb', port: 9494, ssl: true },
    password: 'tok-1234',
    s3: {},
  };
  const at = (text: string): string =>
    `Invalid Input Error: Failed to attach DuckLake MetaData "__ducklake_metadata_lake" at path + "quack:duckdb:9494"${text}`;

  it('sorts a refused or missing token into AUTH_FAILED and the network, TLS and restart failures into CONNECTION_FAILED, each with its own reason', () => {
    const cases: [string, string][] = [
      [at('Authentication failed'), 'AUTH_FAILED'],
      [at('Could not find a Quack authentication token'), 'AUTH_FAILED'],
      [at('Authorization failed'), 'CONNECTION_FAILED'],
      [
        at(
          "Failed to send message: IO Error: Could not connect to server error for HTTP POST to 'http://duckdb:9494/quack'",
        ),
        'CONNECTION_FAILED',
      ],
      [
        at(
          "Failed to send message: IO Error: Could not resolve hostname error for HTTP POST to 'https://duckdb:9494/quack'",
        ),
        'CONNECTION_FAILED',
      ],
      [
        at(
          "Failed to send message: IO Error: SSL peer certificate or SSH remote key was not OK error for HTTP POST to 'https://duckdb:9494/quack'",
        ),
        'CONNECTION_FAILED',
      ],
      [
        at(
          'Failed to send message: the certificate presented by https://duckdb:9494 does not match the pinned ssl_fingerprint',
        ),
        'CONNECTION_FAILED',
      ],
      [
        at(
          "Failed to send message: IO Error: Unsupported protocol error for HTTP POST to 'http://duckdb:9494/quack'",
        ),
        'CONNECTION_FAILED',
      ],
      [
        at(
          "Failed to send message: IO Error: SSL connect error error for HTTP POST to 'https://duckdb:9494/quack'",
        ),
        'CONNECTION_FAILED',
      ],
      [
        'Invalid Input Error: Failed to query most recent snapshot for DuckLake: Invalid connection id',
        'CONNECTION_FAILED',
      ],
    ];
    const messages = cases.map(([text, code]) => {
      const error = dataError(new Error(text), 'setup', quack, table);
      expect(error.code, text).toBe(code);
      return error.userMessage;
    });
    expect(new Set(messages).size).toBe(messages.length);

    // While reading, a refusal of the server stays a failed read.
    expect(
      dataError(new Error('Invalid Input Error: Authorization failed'), 'query', quack, table).code,
    ).toBe('QUERY_FAILED');
  });
});

describe('isCatalogFile', () => {
  it('counts a missing file as one of the catalog only below the data path, not in a folder that starts like it', () => {
    const missing = (path: string): RegExpExecArray => {
      const match = MISSING_LOCAL_FILE.exec(
        `IO Error: Cannot open file "${path}": No such file or directory`,
      );
      if (!match) throw new Error('The test message does not match.');
      return match;
    };
    expect(isCatalogFile(missing('/mnt/lake/main/orders/a.parquet'), '/mnt/lake')).toBe(true);
    expect(isCatalogFile(missing('/mnt/lake2/main/orders/a.parquet'), '/mnt/lake')).toBe(false);
    expect(isCatalogFile(missing(String.raw`C:\lake\main\a.parquet`), 'C:/lake/')).toBe(true);
    expect(isCatalogFile(missing('/mnt/lake/a.parquet'), undefined)).toBe(false);
  });
});
