import { describe, expect, it } from 'vitest';
import type { ConnectionProfile } from '../../src/connections/profile';
import { setupStatements } from '../../src/data/attach';
import type { DataAccess } from '../../src/data/types';

const sqlite: ConnectionProfile = { id: 'a', name: 'a', kind: 'sqlite', path: '/data/lake.sqlite' };
const duckdb: ConnectionProfile = { id: 'b', name: 'b', kind: 'duckdb', path: '/data/lake.duckdb' };
const postgres: ConnectionProfile = {
  id: 'c',
  name: 'c',
  kind: 'postgres',
  host: 'db.example.com',
  port: 5432,
  database: 'lake',
  user: 'writer',
  metadataSchema: 'meta',
};

const SESSION_SETTINGS = [
  'USE lake',
  "SET default_transaction_invalidation_policy = 'SYNTACTIC_ERRORS_DO_NOT_INVALIDATE'",
  'SET autoinstall_known_extensions = false',
  'SET autoload_known_extensions = false',
];

function access(profile: ConnectionProfile, extra: Partial<DataAccess> = {}): DataAccess {
  return { profile, s3: {}, ...extra };
}

describe('setupStatements for an SQL session', () => {
  it('attaches a writable session without a lock and a read-only session READ_ONLY, and uses the lake', () => {
    expect(setupStatements(access(sqlite), { readOnly: false })).toEqual([
      'INSTALL ducklake',
      'LOAD ducklake',
      'INSTALL sqlite',
      'LOAD sqlite',
      "ATTACH 'ducklake:sqlite:/data/lake.sqlite' AS lake (CREATE_IF_NOT_EXISTS false)",
      ...SESSION_SETTINGS,
    ]);
    expect(setupStatements(access(duckdb), { readOnly: true })).toEqual([
      'INSTALL ducklake',
      'LOAD ducklake',
      "ATTACH 'ducklake:/data/lake.duckdb' AS lake (READ_ONLY)",
      ...SESSION_SETTINGS,
    ]);
  });

  it('never sets a DATA_PATH, never locks the configuration and ignores the snapshot of the access', () => {
    for (const profile of [sqlite, duckdb, postgres]) {
      for (const readOnly of [false, true]) {
        const text = setupStatements(access(profile, { password: 'pw', snapshot: 6 }), { readOnly }).join(
          '\n',
        );
        expect(text, `${profile.kind} readOnly=${readOnly}`).not.toMatch(
          /DATA_PATH|lock_configuration|SNAPSHOT_VERSION/,
        );
      }
    }
  });

  it('keeps the PostgreSQL password in the secret only, also when the lake is writable', () => {
    const statements = setupStatements(access(postgres, { password: "p'w" }), { readOnly: false });

    expect(statements).toContain(
      "CREATE OR REPLACE SECRET aantje_pg (TYPE postgres, HOST 'db.example.com', PORT 5432, DATABASE 'lake', USER 'writer', PASSWORD 'p''w', SSLMODE 'disable')",
    );
    expect(statements).toContain(
      "ATTACH 'ducklake:postgres:' AS lake (CREATE_IF_NOT_EXISTS false, META_SECRET 'aantje_pg', METADATA_SCHEMA 'meta')",
    );
    expect(
      statements.filter((statement) => statement.includes("p'w") || statement.includes("p''w")),
    ).toHaveLength(1);
  });
});
