import { describe, expect, it } from 'vitest';
import { quackSetup } from '../../src/catalog/drivers/quack';
import type { ConnectionProfile, QuackProfile } from '../../src/connections/profile';
import { columnsQuery, previewQuery, setupStatements } from '../../src/data/attach';
import type { DataAccess } from '../../src/data/types';
import { buildNotebook } from '../../src/notebook/build';

const sqlite: ConnectionProfile = { id: 'a', name: 'a', kind: 'sqlite', path: '/data/lake.sqlite' };
const duckdb: ConnectionProfile = { id: 'b', name: 'b', kind: 'duckdb', path: '/data/lake.duckdb' };
const postgres: ConnectionProfile = {
  id: 'c',
  name: 'c',
  kind: 'postgres',
  host: 'db.example.com',
  port: 5432,
  database: 'lake',
  user: 'reader',
};
const LOCKDOWN = [
  'SET autoinstall_known_extensions = false',
  'SET autoload_known_extensions = false',
  'SET lock_configuration = true',
];

function access(profile: ConnectionProfile, extra: Partial<DataAccess> = {}): DataAccess {
  return { profile, s3: {}, ...extra };
}

describe('setupStatements', () => {
  it('attaches every profile kind read-only at the latest snapshot, the PostgreSQL password only inside a secret', () => {
    expect(setupStatements(access(sqlite))).toEqual([
      'INSTALL ducklake',
      'LOAD ducklake',
      'INSTALL sqlite',
      'LOAD sqlite',
      "ATTACH 'ducklake:sqlite:/data/lake.sqlite' AS lake (READ_ONLY)",
      ...LOCKDOWN,
    ]);
    expect(setupStatements(access(duckdb))).toEqual([
      'INSTALL ducklake',
      'LOAD ducklake',
      "ATTACH 'ducklake:/data/lake.duckdb' AS lake (READ_ONLY)",
      ...LOCKDOWN,
    ]);
    const pg = setupStatements(access(postgres, { password: 'pw' }));
    expect(pg).toEqual([
      'INSTALL ducklake',
      'LOAD ducklake',
      'INSTALL postgres',
      'LOAD postgres',
      "CREATE OR REPLACE SECRET aantje_pg (TYPE postgres, HOST 'db.example.com', PORT 5432, DATABASE 'lake', USER 'reader', PASSWORD 'pw', SSLMODE 'disable')",
      "ATTACH 'ducklake:postgres:' AS lake (READ_ONLY, META_SECRET 'aantje_pg')",
      ...LOCKDOWN,
    ]);
    expect(pg.filter((sql) => sql.startsWith('ATTACH')).join()).not.toContain('pw');
  });

  it('pins the snapshot with SNAPSHOT_VERSION, also snapshot 0', () => {
    expect(setupStatements(access(sqlite, { snapshot: 6 }))).toContain(
      "ATTACH 'ducklake:sqlite:/data/lake.sqlite' AS lake (READ_ONLY, SNAPSHOT_VERSION 6)",
    );
    expect(setupStatements(access(duckdb, { snapshot: 0 }))).toContain(
      "ATTACH 'ducklake:/data/lake.duckdb' AS lake (READ_ONLY, SNAPSHOT_VERSION 0)",
    );
  });

  it('PostgreSQL: verifies the certificate against the system store with TLS on, selects the metadata schema, pins the snapshot, and has no PASSWORD clause without a password', () => {
    const statements = setupStatements(
      access({ ...postgres, ssl: true, metadataSchema: 'lake_meta' }, { password: 'pw', snapshot: 4 }),
    );
    expect(statements[4]).toBe(
      "CREATE OR REPLACE SECRET aantje_pg (TYPE postgres, HOST 'db.example.com', PORT 5432, DATABASE 'lake', USER 'reader', PASSWORD 'pw', SSLMODE 'verify-full', SSLROOTCERT 'system')",
    );
    expect(statements[5]).toBe(
      "ATTACH 'ducklake:postgres:' AS lake (READ_ONLY, META_SECRET 'aantje_pg', METADATA_SCHEMA 'lake_meta', SNAPSHOT_VERSION 4)",
    );
    expect(setupStatements(access(postgres))[4]).toBe(
      "CREATE OR REPLACE SECRET aantje_pg (TYPE postgres, HOST 'db.example.com', PORT 5432, DATABASE 'lake', USER 'reader', SSLMODE 'disable')",
    );
  });

  it('Quack: loads quack and httpfs, scopes the token to the server, switches TLS and pins the fingerprint on the metadata attach; a session attaches writable', () => {
    const quack: ConnectionProfile = {
      id: 'q',
      name: 'q',
      kind: 'quack',
      host: 'duckdb',
      port: 9494,
      ssl: true,
    };
    const fingerprint = `${'AB:'.repeat(31)}CD`;
    expect(setupStatements(access({ ...quack, fingerprint }, { password: "t'k", snapshot: 4 }))).toEqual([
      'INSTALL ducklake',
      'LOAD ducklake',
      'INSTALL quack',
      'LOAD quack',
      'INSTALL httpfs',
      'LOAD httpfs',
      "CREATE OR REPLACE TEMPORARY SECRET aantje_quack (TYPE quack, TOKEN 't''k', SCOPE 'quack:duckdb:9494')",
      `ATTACH 'ducklake:quack:duckdb:9494' AS lake (CREATE_IF_NOT_EXISTS false, META_DISABLE_SSL false, META_SSL_FINGERPRINT '${fingerprint}', SNAPSHOT_VERSION 4)`,
      ...LOCKDOWN,
    ]);
    const session = setupStatements(access({ ...quack, ssl: false }, { password: 'tok' }), {
      readOnly: false,
    });
    expect(session).toContain(
      "ATTACH 'ducklake:quack:duckdb:9494' AS lake (CREATE_IF_NOT_EXISTS false, META_DISABLE_SSL true)",
    );
    expect(session.filter((sql) => sql.includes("'tok'"))).toHaveLength(1);
    expect(session.filter((sql) => sql === 'LOAD httpfs')).toHaveLength(1);
  });

  it('escapes the quote in every literal (paths, user, database, schema, password, S3 keys) and keeps Windows paths as they are', () => {
    const windows: ConnectionProfile = { ...sqlite, path: "C:\\Users\\O'Brien\\lake.sqlite" };
    expect(setupStatements(access(windows)).at(-4)).toBe(
      "ATTACH 'ducklake:sqlite:C:\\Users\\O''Brien\\lake.sqlite' AS lake (READ_ONLY)",
    );
    const hostile: ConnectionProfile = {
      ...postgres,
      user: "o'neil",
      database: "d'b",
      metadataSchema: "s'x",
    };
    const statements = setupStatements(access(hostile, { password: "p'w" }));
    expect(statements[4]).toContain("USER 'o''neil', PASSWORD 'p''w'");
    expect(statements[4]).toContain("DATABASE 'd''b'");
    expect(statements[5]).toContain("METADATA_SCHEMA 's''x'");
    expect(setupStatements(access(duckdb, { s3Credentials: { keyId: "k'1", secretKey: "s'2" } }))).toContain(
      "CREATE OR REPLACE SECRET aantje_s3 (TYPE s3, KEY_ID 'k''1', SECRET 's''2')",
    );
  });

  describe('S3', () => {
    it('loads httpfs and creates the secret only when an endpoint or credentials exist; region and URL style alone complete a secret, they do not make one', () => {
      const alone = [
        {},
        { region: 'us-east-1', urlStyle: 'path' as const },
        { region: 'eu-central-1' },
        { urlStyle: 'vhost' as const },
        { endpoint: '   ', region: 'eu-west-1' },
      ];
      for (const s3 of alone) {
        for (const profile of [duckdb, sqlite, postgres]) {
          for (const session of [undefined, { readOnly: false }]) {
            const text = setupStatements(access(profile, { s3 }), session).join('\n');
            expect(text, JSON.stringify(s3)).not.toMatch(/httpfs|aantje_s3/);
          }
        }
      }
      expect(setupStatements(access(duckdb, { s3: { endpoint: '   ' } }))).toEqual(
        setupStatements(access(duckdb)),
      );

      expect(
        setupStatements(
          access(sqlite, {
            s3Credentials: { keyId: 'AKIA', secretKey: 'sec/ret+' },
            s3: { region: 'eu-west-1' },
          }),
        ).slice(0, 7),
      ).toEqual([
        'INSTALL ducklake',
        'LOAD ducklake',
        'INSTALL sqlite',
        'LOAD sqlite',
        'INSTALL httpfs',
        'LOAD httpfs',
        "CREATE OR REPLACE SECRET aantje_s3 (TYPE s3, KEY_ID 'AKIA', SECRET 'sec/ret+', REGION 'eu-west-1')",
      ]);
      expect(
        setupStatements(access(duckdb, { s3: { endpoint: 'http://localhost:9000', urlStyle: 'path' } })),
      ).toContain(
        "CREATE OR REPLACE SECRET aantje_s3 (TYPE s3, ENDPOINT 'localhost:9000', USE_SSL false, URL_STYLE 'path')",
      );
    });

    it('turns the endpoint into ENDPOINT and USE_SSL: a scheme sets the flag, blanks and trailing slashes go', () => {
      const endpoints = [
        ['minio.local:9000', "ENDPOINT 'minio.local:9000'"],
        ['http://minio.local:9000', "ENDPOINT 'minio.local:9000', USE_SSL false"],
        ['HTTPS://s3.example.com/', "ENDPOINT 's3.example.com', USE_SSL true"],
        ['  http://127.0.0.1:9000//  ', "ENDPOINT '127.0.0.1:9000', USE_SSL false"],
      ];
      for (const [endpoint, expected] of endpoints) {
        const statements = setupStatements(
          access(duckdb, {
            s3: { endpoint, region: 'us-east-1', urlStyle: 'path' },
            s3Credentials: { keyId: 'k', secretKey: 's' },
          }),
        );
        expect(statements, endpoint).toContain(
          `CREATE OR REPLACE SECRET aantje_s3 (TYPE s3, KEY_ID 'k', SECRET 's', REGION 'us-east-1', ${expected}, URL_STYLE 'path')`,
        );
      }
    });

    it('puts httpfs and the secret before the ATTACH and before the autoload is switched off, in the SQL session too', () => {
      const statements = setupStatements(
        access(duckdb, { s3: { endpoint: 'minio:9000', region: 'eu-west-1' } }),
        { readOnly: false },
      );
      const load = statements.indexOf('LOAD httpfs');
      const secret = statements.indexOf(
        "CREATE OR REPLACE SECRET aantje_s3 (TYPE s3, REGION 'eu-west-1', ENDPOINT 'minio:9000')",
      );
      expect(load).toBeGreaterThan(-1);
      expect(secret).toBeGreaterThan(load);
      expect(statements.findIndex((sql) => sql.startsWith('ATTACH'))).toBeGreaterThan(secret);
      expect(statements.indexOf('SET autoload_known_extensions = false')).toBeGreaterThan(secret);
    });
  });
});

describe('previewQuery and columnsQuery', () => {
  it('read one row more than the limit, or none, from the quoted relation, hostile names included', () => {
    expect(previewQuery({ schema: 'sales', table: 'orders' })).toBe(
      'SELECT * FROM lake."sales"."orders" LIMIT 1001',
    );
    expect(columnsQuery({ schema: 'sales', table: 'orders' })).toBe(
      'SELECT * FROM lake."sales"."orders" LIMIT 0',
    );
    const hostile = { schema: 'we"ird', table: 'a b"; DROP TABLE x; --' };
    expect(previewQuery(hostile)).toBe('SELECT * FROM lake."we""ird"."a b""; DROP TABLE x; --" LIMIT 1001');
    expect(columnsQuery(hostile)).toBe('SELECT * FROM lake."we""ird"."a b""; DROP TABLE x; --" LIMIT 0');
  });
});

describe('the attach of a Quack catalog', () => {
  // Quack accepts READ_ONLY without enforcing it, newer quack builds refuse it, and a pin together with TLS off fails.
  it('is never READ_ONLY, in the explorer, the engine and the notebook, and sends no pin while TLS is off', () => {
    const fingerprint = `${'AB:'.repeat(31)}CD`;
    const plain: QuackProfile = {
      id: 'q',
      name: 'q',
      kind: 'quack',
      host: 'h',
      port: 1,
      ssl: false,
      fingerprint,
    };
    const texts = (profile: QuackProfile): string[] => [
      ...quackSetup({ ...profile, token: 'tok' }),
      ...setupStatements(access(profile, { password: 'tok', snapshot: 3 })),
      ...setupStatements(access(profile, { password: 'tok' }), { readOnly: true }),
      ...buildNotebook({
        connectionName: 'q',
        profile,
        table: { schema: 'main', table: 't' },
        s3: {},
        generatedOn: '2026-11-02',
      }).map(({ source }) => source),
    ];

    expect(texts(plain).join('\n')).not.toMatch(/READ_ONLY|AB:AB/);
    const pinned = texts({ ...plain, ssl: true }).join('\n');
    expect(pinned).not.toContain('READ_ONLY');
    expect(pinned).toContain(fingerprint);
  });
});
