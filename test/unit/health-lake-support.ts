import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { expect } from 'vitest';
import { openDuckdb } from '../../src/catalog/drivers/duckdb';
import { createCatalogReader } from '../../src/catalog/reader';
import type { FileProfile } from '../../src/connections/profile';
import { runHealthCheck } from '../../src/health/run';
import type { HealthReport, HealthScope } from '../../src/health/model';
import { accessFor, extensionDirectory } from './data-support';
import { NOW } from './health-support';

/** A lake that DuckDB writes: `stage` runs statements on it, `check` runs the deep health check on the lake or a table. */
export function createLake(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const profile: FileProfile = {
    id: 'lake',
    name: 'lake',
    kind: 'duckdb',
    path: join(directory, 'lake.ducklake'),
  };

  /** Runs `work` on the lake with the real engine and closes it again, so that the reader can open the file. */
  async function session<T>(
    work: (run: (sql: string) => Promise<Record<string, unknown>[]>) => Promise<T>,
  ): Promise<T> {
    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      await connection.run('LOAD ducklake');
      await connection.run(
        `ATTACH 'ducklake:${profile.path.replaceAll('\\', '/')}' AS lake (DATA_PATH '${directory.replaceAll('\\', '/')}/files/', DATA_INLINING_ROW_LIMIT 0)`,
      );
      await connection.run('USE lake');
      return await work(async (sql) => (await connection.runAndReadAll(sql)).getRowObjectsJson());
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }

  async function stage(statements: readonly string[]): Promise<void> {
    await session(async (run) => {
      for (const sql of statements) await run(sql);
    });
  }

  async function query(sql: string): Promise<Record<string, unknown>[]> {
    return session((run) => run(sql));
  }

  async function checkScope(scope: HealthScope): Promise<HealthReport> {
    const reader = createCatalogReader(await openDuckdb({ path: profile.path }));
    try {
      return await runHealthCheck(
        {
          reader,
          access: accessFor({ profile, directory, remove: () => Promise.resolve() }),
          now: () => NOW,
        },
        {
          scope,
          depth: 'deep',
          snapshot: (await reader.info()).latestSnapshot,
        },
      );
    } finally {
      await reader.close();
    }
  }

  const check = (tableId?: number): Promise<HealthReport> =>
    checkScope(tableId === undefined ? { kind: 'lake' } : { kind: 'table', tableId });

  /** The ids of the schemas by name at the newest snapshot. */
  async function schemaIds(): Promise<Map<string, number>> {
    const reader = createCatalogReader(await openDuckdb({ path: profile.path }));
    try {
      const schemas = await reader.schemas((await reader.info()).latestSnapshot);
      return new Map(schemas.map((schema) => [schema.name, schema.id]));
    } finally {
      await reader.close();
    }
  }

  /** The ids of the tables by name at the newest snapshot. */
  async function tableIds(): Promise<Map<string, number>> {
    const reader = createCatalogReader(await openDuckdb({ path: profile.path }));
    try {
      const entries = await reader.entries((await reader.info()).latestSnapshot);
      return new Map(
        entries.filter((entry) => entry.kind === 'table').map((entry) => [entry.name, entry.id]),
      );
    } finally {
      await reader.close();
    }
  }

  /** Neither an error nor a warning, and every group ran. */
  async function expectHealthy(tableId?: number): Promise<HealthReport> {
    const report = await check(tableId);
    expect(
      report.findings.filter((item) => item.severity !== 'info').map((item) => `${item.id}: ${item.detail}`),
    ).toEqual([]);
    expect(report.groups.map((group) => group.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(report.snapshot).toBeGreaterThan(0);
    return report;
  }

  return {
    directory,
    stage,
    query,
    check,
    checkScope,
    schemaIds,
    tableIds,
    expectHealthy,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}
