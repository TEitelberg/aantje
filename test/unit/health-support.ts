import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join, relative, sep } from 'node:path';
import { createCatalogReader } from '../../src/catalog/reader';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader } from '../../src/catalog/model';
import type { DataAccess } from '../../src/data/types';
import { runHealthCheck } from '../../src/health/run';
import type { HealthDeps, HealthRun } from '../../src/health/run';
import type { HealthFinding, HealthReport, HealthRequest } from '../../src/health/model';
import { wasmPath } from '../support/fixtures';
import { DuckDBInstance } from '@duckdb/node-api';
import { withLakeSession } from '../../src/data/engine';
import { accessFor, extensionDirectory } from './data-support';
import type { DataFixture } from './data-support';

/** The clock of the tests: the time of the history fixture, a day after its last snapshot. */
export const NOW = new Date('2026-10-31T12:00:00Z');

export const lake = { kind: 'lake' } as const;

/** A reader on the SQLite catalog of a fixture copy; close it when done. */
export async function readerOf(fixture: DataFixture): Promise<CatalogReader> {
  return createCatalogReader(await openSqlite({ path: fixture.profile.path, wasmPath }));
}

/**
 * Runs the check on a fixture copy with the clock of the tests. The reader is the SQLite catalog of the fixture, opened
 * and closed here, unless `extra.reader` brings one (an edited copy of a catalog).
 */
export async function checkFixture(
  fixture: DataFixture,
  request: Partial<HealthRequest> & Pick<HealthRequest, 'scope'>,
  access: Partial<DataAccess> = {},
  extra: Partial<Omit<HealthDeps, 'reader'>> & { reader?: CatalogReader } = {},
  run: HealthRun = {},
): Promise<HealthReport> {
  const reader = extra.reader ?? (await readerOf(fixture));
  try {
    return await runHealthCheck(
      { access: accessFor(fixture, access), now: () => NOW, ...extra, reader },
      { depth: 'quick', snapshot: 56, ...request },
      run,
    );
  } finally {
    if (!extra.reader) await reader.close();
  }
}

/** The ids of the findings of a report, in report order. */
export function ids(report: HealthReport, group?: HealthFinding['group']): string[] {
  return report.findings.filter((item) => group === undefined || item.group === group).map((item) => item.id);
}

/** The findings that are errors or warnings: a healthy lake has none. */
export function problems(report: HealthReport): HealthFinding[] {
  return report.findings.filter((item) => item.severity !== 'info');
}

const NO_SUCH_BUCKET =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>';
const DENIED = {
  denied: ['AccessDenied', 'Access Denied'],
  signature: [
    'SignatureDoesNotMatch',
    'The request signature we calculated does not match the signature you provided. Check your AWS secret access key and signing method. For more information, see REST Authentication and SOAP Authentication for details.',
  ],
  keyId: ['InvalidAccessKeyId', 'The Access Key Id you provided does not exist in our records.'],
} as const;

/** `filesDenied` answers the listings and refuses the Parquet files. */
export type StoreMode = 'serve' | 'proxy' | 'denied' | 'signature' | 'keyId' | 'filesDenied';

export interface FakeStore {
  readonly endpoint: string;
  readonly mode: { value: StoreMode };
  /** Keys per page of a listing; DuckDB follows the continuation token. */
  readonly pageSize: { value: number };
  /** Every request as `METHOD path?query`. */
  readonly requests: string[];
  close(): Promise<void>;
}

function allFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? allFiles(join(root, entry.name)) : [join(root, entry.name)],
  );
}

const xml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** S3 writes keys url-encoded when the request says `encoding-type=url`; the slashes stay. */
const encodeKey = (key: string): string => encodeURIComponent(key).replaceAll('%2F', '/');

/**
 * An S3 endpoint (path style) over a directory: the keys `<prefix>/<path>` of the bucket are the files below `root`.
 * It answers listings (ListObjectsV2 with prefix, delimiter, continuation and pages), ranged reads and HEAD like RustFS
 * does, and the refusals of a store: 404 for a missing bucket, 403 with the S3 error codes, a proxy without a route.
 * The files are read from the disk on every request, so a test removes or adds a file by touching the directory.
 */
export function startFakeStore(root: string, bucket: string, prefix: string): Promise<FakeStore> {
  const mode = { value: 'serve' as StoreMode };
  const pageSize = { value: 1000 };
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://store');
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const send = (status: number, body: string | undefined, type = 'application/xml'): void => {
      response.writeHead(status, { 'content-type': type });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const error = (status: number, code: string, message: string): void =>
      send(
        status,
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
      );
    if (mode.value === 'proxy') {
      send(404, '<html><body><h1>404 page not found</h1></body></html>', 'text/html');
      return;
    }
    const refusal =
      mode.value === 'filesDenied' ? (url.pathname.endsWith('.parquet') ? 'denied' : 'serve') : mode.value;
    if (refusal !== 'serve') {
      const [code, message] = DENIED[refusal];
      error(403, code, message);
      return;
    }
    const path = decodeURIComponent(url.pathname);
    const [, named = '', key = ''] = /^\/([^/]+)\/?(.*)$/.exec(path) ?? [];
    if (named !== bucket) {
      send(404, NO_SUCH_BUCKET);
      return;
    }
    if (url.searchParams.get('list-type') === '2') {
      const wanted = url.searchParams.get('prefix') ?? '';
      const delimiter = url.searchParams.get('delimiter');
      const token = url.searchParams.get('continuation-token');
      const after = token === null ? '' : Buffer.from(token, 'base64url').toString();
      const keys = allFiles(root)
        .map((file) => `${prefix}/${relative(root, file).split(sep).join('/')}`)
        .filter((candidate) => candidate.startsWith(wanted));
      // With a delimiter the keys below a folder come back as one entry for the folder.
      const entries = new Map<string, boolean>();
      for (const candidate of keys) {
        const cut = delimiter ? candidate.indexOf(delimiter, wanted.length) : -1;
        entries.set(cut >= 0 ? candidate.slice(0, cut + 1) : candidate, cut >= 0);
      }
      const sorted = [...entries]
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([name]) => name > after);
      const page = sorted.slice(0, pageSize.value);
      const more = sorted.length > page.length;
      const last = page.at(-1)?.[0] ?? '';
      const item = ([name, folder]: [string, boolean]): string => {
        if (folder) return `<CommonPrefixes><Prefix>${xml(encodeKey(name))}</Prefix></CommonPrefixes>`;
        const file = statSync(join(root, name.slice(prefix.length + 1)));
        return `<Contents><ETag>"${file.size.toString(16).padStart(32, '0')}"</ETag><Key>${xml(encodeKey(name))}</Key><LastModified>${new Date(file.mtimeMs).toISOString()}</LastModified><Size>${file.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
      };
      // The element order and the namespace are those of RustFS 1.0.4: DuckDB reads the size from them without a HEAD.
      const body = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xml(encodeKey(wanted))}</Prefix><MaxKeys>${pageSize.value}</MaxKeys><KeyCount>${page.length}</KeyCount><IsTruncated>${more}</IsTruncated>${
        more
          ? `<NextContinuationToken>${Buffer.from(last).toString('base64url')}</NextContinuationToken>`
          : ''
      }${page.map(item).join('')}${delimiter ? `<Delimiter>${xml(delimiter)}</Delimiter>` : ''}<EncodingType>url</EncodingType></ListBucketResult>`;
      send(200, body);
      return;
    }
    const file = key.startsWith(`${prefix}/`) ? join(root, key.slice(prefix.length + 1)) : undefined;
    if (file === undefined || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      error(404, 'NoSuchKey', 'The specified key does not exist.');
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
      'last-modified': new Date(statSync(file).mtimeMs).toUTCString(),
      ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}),
    });
    response.end(request.method === 'HEAD' ? undefined : partial);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        mode,
        pageSize,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Runs statements on the SQLite catalog of a fixture copy with the real engine (the SQLite extension of DuckDB). */
export async function editCatalog(fixture: DataFixture, statements: readonly string[]): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
  const connection = await instance.connect();
  try {
    await connection.run('LOAD sqlite');
    await connection.run(`ATTACH '${fixture.profile.path.replaceAll("'", "''")}' AS meta (TYPE sqlite)`);
    for (const statement of statements) {
      await connection.run(statement);
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** Runs the SQL that the findings offer for inspection on the lake, in one engine session; returns the ones that fail. */
export async function failingInspections(fixture: DataFixture, report: HealthReport): Promise<string[]> {
  const failed: string[] = [];
  await withLakeSession(accessFor(fixture), undefined, async (session) => {
    for (const item of report.findings) {
      if (item.inspectSql === undefined) continue;
      try {
        await session.rows(item.inspectSql.replace(/;\s*$/, ''));
      } catch (error) {
        failed.push(`${item.id}: ${(error as Error).message}`);
      }
    }
  });
  return failed;
}
