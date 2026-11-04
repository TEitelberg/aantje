import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { previewTable } from '../../src/data/engine';
import { AantjeError } from '../../src/errors';
import { openSqlSession } from '../../src/sql/session';
import { accessFor, copyDataFixture, engineSkipReason } from './data-support';
import type { DataFixture } from './data-support';
import { events, only } from './sql-support';
import type { DataAccess } from '../../src/data/types';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Missing-object tests are skipped: ${skipReason}`);
}

const orders = { schema: 'sales', table: 'orders' };
const BUCKET = 'example-lake';
const FILE = String.raw`s3://${BUCKET}/ducklake/sales/orders/ducklake-[0-9a-f-]+\.parquet`;

// The bodies are those of RustFS 1.0.4 (rustfs/rustfs) for a key and a bucket that do not exist.
const NO_SUCH_KEY =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>';
const NO_SUCH_BUCKET =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>';

type Mode = 'serve' | 'missing' | 'proxy' | 'forbidden';

/**
 * An S3 endpoint over the Parquet files of a data fixture (path style, ranges, HEAD). In mode `missing` it answers like
 * RustFS does when the objects are gone, in mode `proxy` like a web server that is not an object store.
 */
function startStore(
  fixture: DataFixture,
): Promise<{ server: Server; endpoint: string; mode: { value: Mode }; requests: string[] }> {
  const mode = { value: 'serve' as Mode };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://store').pathname);
    requests.push(`${request.method} ${path}`);
    const [, bucket = '', rest = ''] = /^\/([^/]+)\/ducklake\/(.*)$/.exec(path) ?? [];
    const file = join(fixture.directory, 'sqlite-files', rest);
    const found =
      mode.value === 'serve' && bucket === BUCKET && statSync(file, { throwIfNoEntry: false })?.isFile();
    if (!found) {
      const [status, body] =
        mode.value === 'forbidden'
          ? [403, '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>']
          : mode.value === 'proxy'
            ? [404, '<html><body><h1>404 page not found</h1></body></html>']
            : [404, bucket === BUCKET ? NO_SUCH_KEY : NO_SUCH_BUCKET];
      response.writeHead(status, {
        'content-type': mode.value === 'proxy' ? 'text/html' : 'application/xml',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    const bytes = readFileSync(file);
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    const start = range?.[1] ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    const partial = range ? bytes.subarray(start, end + 1) : bytes;
    response.writeHead(range ? 206 : 200, {
      'content-length': partial.length,
      'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}),
    });
    response.end(request.method === 'HEAD' ? undefined : partial);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, endpoint: `http://127.0.0.1:${port}`, mode, requests });
    });
  });
}

async function failure(promise: Promise<unknown>): Promise<AantjeError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AantjeError);
  return error as AantjeError;
}

describe.skipIf(skipReason)('a catalog that lists data files the object store does not have', () => {
  let fixture: DataFixture;
  let store: Awaited<ReturnType<typeof startStore>>;
  let access: (extra?: Partial<DataAccess>) => DataAccess;

  beforeAll(async () => {
    fixture = await copyDataFixture('sqlite', `s3://${BUCKET}/ducklake/`);
    store = await startStore(fixture);
    access = (extra = {}) =>
      accessFor(fixture, { s3: { endpoint: store.endpoint, urlStyle: 'path' }, ...extra });
  });
  afterAll(async () => {
    store.server.closeAllConnections();
    store.server.close();
    await fixture.remove();
  });
  beforeEach(() => {
    store.mode.value = 'serve';
    store.requests.length = 0;
  });
  afterEach(() => {
    store.mode.value = 'serve';
  });

  it('reads the Parquet files from the store when they are there (the baseline of the failures below)', async () => {
    const data = await previewTable(access(), orders);

    expect(data.rows.map((row) => row[0])).toEqual([1, 3]);
    expect(
      store.requests.some((line) => line.startsWith(`GET /${BUCKET}/ducklake/sales/orders/ducklake-`)),
    ).toBe(true);
  });

  it('names the file, the answer of the store and the causes when the newest snapshot lists a file that is gone', async () => {
    store.mode.value = 'missing';

    const error = await failure(previewTable(access(), orders));

    expect(error.code).toBe('QUERY_FAILED');
    expect(error.userMessage).toMatch(
      new RegExp(
        `^Cannot read the data of "sales\\.orders": the catalog lists the data file ${FILE}, but the object store answered HTTP 404 \\(NoSuchKey: the object does not exist\\)\\. Likely causes: the file was deleted or never written \\(a cleaned-up bucket, a manual delete, a storage volume that was reset\\); the setting aantje\\.s3\\.endpoint, the bucket or the data_path of the catalog points to another store than the one the lake was written to\\.$`,
      ),
    );
    expect((error.cause as Error).message).toMatch(
      /^HTTP Error: HTTP GET error reading 's3:\/\/example-lake\/.*\(HTTP 404 Not Found\)$/,
    );
  });

  it('says which snapshot was read and that a newer one exists when an older snapshot is pinned', async () => {
    store.mode.value = 'missing';

    const error = await failure(previewTable(access({ snapshot: 5 }), orders));

    expect(error.userMessage).toContain(
      'Likely causes: an older snapshot still lists a file that another writer or a manual cleanup removed afterwards; the file was deleted',
    );
    expect(error.userMessage).toMatch(
      /This read used snapshot @5, the newest is @13: choose a newer snapshot or use Show Latest Snapshot\.$/,
    );
  });

  it('says that a newer snapshot does not help when the newest snapshot is the one that was read', async () => {
    store.mode.value = 'missing';

    const error = await failure(previewTable(access({ snapshot: 13 }), orders));

    expect(error.userMessage).not.toContain('an older snapshot');
    expect(error.userMessage).toMatch(
      /This read used the newest snapshot @13, so a newer snapshot will not help\.$/,
    );
  });

  it('tells a missing bucket from a missing object', async () => {
    store.mode.value = 'missing';
    const elsewhere = await copyDataFixture('sqlite', 's3://nosuchbucket/ducklake/');
    try {
      const error = await failure(
        previewTable(accessFor(elsewhere, { s3: { endpoint: store.endpoint, urlStyle: 'path' } }), orders),
      );

      expect(error.userMessage).toContain('s3://nosuchbucket/ducklake/sales/orders/ducklake-');
      expect(error.userMessage).toContain('HTTP 404 (NoSuchBucket: the bucket does not exist).');
    } finally {
      await elsewhere.remove();
    }
  });

  it('words a 404 of a server that is no object store without an S3 error code', async () => {
    store.mode.value = 'proxy';

    const error = await failure(previewTable(access(), orders));

    expect(error.userMessage).toMatch(
      new RegExp(`the data file ${FILE}, but the object store answered HTTP 404\\. Likely causes: `),
    );
    expect(error.userMessage).not.toContain('NoSuch');
    expect(error.userMessage).toContain('the setting aantje.s3.endpoint');
    expect(error.userMessage).not.toMatch(/aantje\.s3\.(region|urlStyle)/);
  });

  it('keeps the access denied text of a refused request as it was', async () => {
    store.mode.value = 'forbidden';

    const error = await failure(previewTable(access(), orders));

    expect(error.userMessage).toMatch(
      new RegExp(
        `^Cannot read the data of "sales\\.orders": HTTP Error: HTTP GET error reading '${FILE}' \\(HTTP 403 Forbidden\\)\\. Check that the data files exist and, for S3 data, the settings aantje\\.s3\\.\\* and the command "aantje: Set S3 Credentials\\.\\.\\."\\.$`,
      ),
    );
  });

  it('keeps the key id and the secret out of the message although the url contains them', async () => {
    store.mode.value = 'missing';

    const error = await failure(
      previewTable(access({ s3Credentials: { keyId: BUCKET, secretKey: 'ducklake' } }), orders),
    );

    for (const text of [error.userMessage, (error.cause as Error).message]) {
      expect(text).not.toContain(BUCKET);
      expect(text).not.toContain('s3://example-lake');
      expect(text).toContain('s3://***/***/sales/orders/***-');
    }
  });

  it('reads again as soon as the files are back: a 404 is not remembered', async () => {
    store.mode.value = 'missing';
    await failure(previewTable(access(), orders));

    store.mode.value = 'serve';

    expect((await previewTable(access(), orders)).rows).toHaveLength(2);
  });

  describe('in the SQL editor', () => {
    it('does not claim that the catalog lists a file that the query reads by a url of its own', async () => {
      const session = await openSqlSession({ access: access(), mode: 'read-only' });
      try {
        store.mode.value = 'missing';
        const failed = await events(
          session,
          `SELECT * FROM read_parquet('${store.endpoint}/my/own.parquet')`,
        );

        expect(only(failed, 'error')).toHaveLength(1);
        const message = only(failed, 'error')[0]?.message ?? '';
        expect(message).toMatch(
          /^Cannot read a data file: the object store answered HTTP 404 for http:\/\/127\.0\.0\.1:\d+\/my\/own\.parquet( \(NoSuch\w+: [^)]+\))?\.$/,
        );
        expect(message).not.toContain('the catalog lists');
      } finally {
        await session.close();
      }
    });

    it('explains the 404 of a query, and the same session reads on once the files are back', async () => {
      const session = await openSqlSession({ access: access(), mode: 'read-only' });
      try {
        store.mode.value = 'missing';
        const failed = await events(session, 'SELECT * FROM sales.orders');

        expect(only(failed, 'error')).toHaveLength(1);
        expect(only(failed, 'error')[0]?.message).toMatch(
          new RegExp(
            `^Cannot read a data file: the catalog lists the data file ${FILE}, but the object store answered HTTP 404 \\(NoSuchKey: the object does not exist\\)\\. Likely causes: the file was deleted or never written .*lake was written to\\. If the statement reads an older snapshot \\(AT \\(VERSION => \\.\\.\\.\\)\\), try a newer one\\.$`,
          ),
        );

        store.mode.value = 'serve';
        const again = await events(session, 'SELECT id FROM sales.orders ORDER BY id');

        expect(only(again, 'resultSet')[0]?.rows).toEqual([[1], [3]]);
      } finally {
        await session.close();
      }
    });
  });
});
