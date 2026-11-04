import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupStatements } from '../../src/data/attach';
import { describeRelation } from '../../src/data/engine';
import { openSqlSession } from '../../src/sql/session';
import { accessFor, copyDataFixture, engineSkipReason, extensionDirectory } from './data-support';
import type { DataFixture } from './data-support';
import { query } from './sql-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`S3 setup tests are skipped: ${skipReason}`);
}

const orders = { schema: 'sales', table: 'orders' };
const run = Object.getOwnPropertyDescriptor(DuckDBConnection.prototype, 'run')
  ?.value as DuckDBConnection['run'];
const SECRETS = 'SELECT name, secret_string FROM duckdb_secrets() ORDER BY name';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The statements of one setup that run before the ATTACH, on a real DuckDB that cannot load an extension on its own. */
async function setUpWithoutAutoload(
  statements: readonly string[],
): Promise<{ httpfs: unknown; secrets: unknown[][] }> {
  const instance = await DuckDBInstance.create(':memory:', {
    extension_directory: extensionDirectory,
    autoload_known_extensions: 'false',
    autoinstall_known_extensions: 'false',
    allow_persistent_secrets: 'false',
  });
  const connection = await instance.connect();
  try {
    for (const sql of statements.slice(
      0,
      statements.findIndex((statement) => statement.startsWith('ATTACH')),
    )) {
      await connection.run(sql);
    }
    const httpfs = (
      await connection.runAndReadAll("SELECT loaded FROM duckdb_extensions() WHERE extension_name = 'httpfs'")
    ).getRowsJson()[0]?.[0];
    return { httpfs, secrets: (await connection.runAndReadAll(SECRETS)).getRowsJson() };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

describe.skipIf(skipReason !== undefined)('S3 settings in the setup of the engine', () => {
  const dummy: DataFixture = {
    profile: { id: 'x', name: 'x', kind: 'duckdb', path: '/data/lake.duckdb' },
    directory: '',
    remove: () => Promise.resolve(),
  };

  it.each([
    [
      'an endpoint with the region and the URL style',
      { endpoint: 'minio.local:9000', region: 'eu-west-1', urlStyle: 'path' as const },
      ['endpoint=minio.local:9000', 'region=eu-west-1', 'url_style=path'],
    ],
    [
      'an endpoint alone',
      { endpoint: 'http://localhost:9000' },
      ['endpoint=localhost:9000', 'use_ssl=false'],
    ],
  ])('loads httpfs, and the secret parses and carries the settings: %s', async (_name, s3, texts) => {
    const { httpfs, secrets: created } = await setUpWithoutAutoload(
      setupStatements(accessFor(dummy, { s3 })),
    );

    expect(httpfs).toBe(true);
    expect(created.map(([name]) => name)).toEqual(['aantje_s3']);
    for (const text of texts) {
      expect(String(created[0]?.[1])).toContain(text);
    }
  });

  it('loads httpfs and creates the secret for credentials, with the region next to them', async () => {
    const { httpfs, secrets: created } = await setUpWithoutAutoload(
      setupStatements(
        accessFor(dummy, {
          s3: { region: 'eu-west-1', urlStyle: 'path' },
          s3Credentials: { keyId: 'AKIAEXAMPLE', secretKey: 'example-secret' },
        }),
      ),
    );

    expect(httpfs).toBe(true);
    expect(String(created[0]?.[1])).toContain('region=eu-west-1');
  });

  it.each([
    ['the production defaults', { region: 'us-east-1', urlStyle: 'path' as const }],
    ['a region', { region: 'eu-west-1' }],
    ['a URL style', { urlStyle: 'vhost' as const }],
  ])(
    'loads no httpfs and creates no secret for %s alone, so an offline machine opens a local lake',
    async (_name, s3) => {
      const { httpfs, secrets: created } = await setUpWithoutAutoload(
        setupStatements(accessFor(dummy, { s3 })),
      );

      expect(httpfs).toBe(false);
      expect(created).toEqual([]);
    },
  );

  describe('on a lake whose data path is on S3', () => {
    /** Every statement the engine is given while `action` runs. */
    async function ran(action: () => Promise<unknown>): Promise<string[]> {
      const seen: string[] = [];
      const spy = vi.spyOn(DuckDBConnection.prototype, 'run').mockImplementation(async function (
        this: DuckDBConnection,
        sql,
        ...rest
      ) {
        seen.push(sql);
        return run.call(this, sql, ...rest);
      });
      try {
        await action();
      } finally {
        spy.mockRestore();
      }
      return seen;
    }

    it.each([
      ['nothing configured', {}],
      ['only the region and the URL style set', { region: 'eu-west-1', urlStyle: 'path' as const }],
    ])(
      'has httpfs in a session with %s: the ATTACH loads it by itself, before the autoload is switched off',
      async (_name, s3) => {
        const fixture = await copyDataFixture('duckdb', 's3://aantje-test/');
        try {
          const statements = await ran(async () => {
            const session = await openSqlSession({ access: accessFor(fixture, { s3 }), mode: 'read-only' });
            try {
              const [loaded] = (
                await query(session, "SELECT loaded FROM duckdb_extensions() WHERE extension_name = 'httpfs'")
              ).rows[0] ?? [false];
              expect(loaded).toBe(true);
            } finally {
              await session.close();
            }
          });
          expect(statements.join('\n')).not.toContain('httpfs');
        } finally {
          await fixture.remove();
        }
      },
      30_000,
    );

    it('gives the one-shot read and the SQL session the same httpfs and the secret with the endpoint and region', async () => {
      const fixture = await copyDataFixture('duckdb', 's3://aantje-test/');
      try {
        const access = accessFor(fixture, {
          s3: { endpoint: 'localhost:9', region: 'eu-west-1', urlStyle: 'path' },
        });
        const secret =
          "CREATE OR REPLACE SECRET aantje_s3 (TYPE s3, REGION 'eu-west-1', ENDPOINT 'localhost:9', URL_STYLE 'path')";

        const oneShot = await ran(() => describeRelation(access, orders));
        const inSession = await ran(async () => {
          const session = await openSqlSession({ access, mode: 'read-only' });
          try {
            const [name, text] = (await query(session, SECRETS)).rows[0] ?? [];
            expect(name).toBe('aantje_s3');
            expect(String(text)).toContain('region=eu-west-1');
            expect(String(text)).toContain('url_style=path');
            const [loaded] = (
              await query(session, "SELECT loaded FROM duckdb_extensions() WHERE extension_name = 'httpfs'")
            ).rows[0] ?? [false];
            expect(loaded).toBe(true);
          } finally {
            await session.close();
          }
        });

        for (const statements of [oneShot, inSession]) {
          expect(statements).toContain('INSTALL httpfs');
          expect(statements).toContain('LOAD httpfs');
          expect(statements).toContain(secret);
          expect(statements.indexOf(secret)).toBeLessThan(
            statements.findIndex((sql) => sql.startsWith('ATTACH')),
          );
        }
      } finally {
        await fixture.remove();
      }
    }, 30_000);
  });
});
