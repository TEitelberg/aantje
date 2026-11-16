// Sync to Iceberg of tables that were synced before: brings each Iceberg table to the state of its lake table at the
// snapshot of the sync, as the plan of `sync-plan.ts` says: append the rows the lake inserted, replace the rows, or
// write the table new. Checked with DuckDB 2.0 against Polaris.
import { quoteIdentifier, quoteLiteral } from '../catalog/ddl';
import { setupStatements } from '../data/attach';
import { secretsOf } from '../data/errors';
import { guardRelation } from '../data/guard';
import { withOpenLake } from '../data/open-lake';
import type { DataAccess, TableRef } from '../data/types';
import { loadEngine } from '../duckdb/engine';
import { extensionFailure, scrubbed } from '../duckdb/messages';
import { AantjeError } from '../errors';
import { icebergSnapshotOf, icebergTable, originProperties, quoted } from './copy';
import type { IcebergName } from './copy';
import { selectList } from './mapping';
import { ICEBERG, icebergSetup } from './statements';
import type { SyncStep } from './sync-plan';
import type { IcebergTarget } from './target';

export interface SyncRequest {
  /** The lake; `snapshot` undefined syncs to the newest one. */
  readonly access: DataAccess;
  readonly target: IcebergTarget;
  readonly secret: string | undefined;
  /** The steps that write: `none` and `skip` are left out by the caller. */
  readonly steps: readonly SyncStep[];
  /** The `PARTITIONED BY` list of each table that is written new, by `schema.table` of the lake. */
  readonly partitions?: ReadonlyMap<string, string>;
  readonly report?: (text: string) => void;
}

export interface TableSync {
  readonly step: SyncStep;
  readonly status: 'synced' | 'failed';
  /** The rows written: appended, or all rows of a replaced or new table. */
  readonly rows?: number;
  readonly icebergSnapshot?: string;
  readonly converted?: readonly string[];
  readonly error?: string;
}

export interface SyncResult {
  /** The DuckLake snapshot every table was read at. */
  readonly snapshot: number;
  readonly snapshotTime: string | undefined;
  readonly tables: readonly TableSync[];
}

/** Where the Iceberg table of a record is. */
export const icebergNameOfRecord = (step: SyncStep): IcebergName => ({
  namespace: step.record.icebergNamespace ?? step.record.schema,
  name: step.record.icebergTable ?? step.record.table,
});

/**
 * Carries out the steps in one private DuckDB with the lake attached read-only and the Iceberg catalog: each table in a
 * transaction of its own, after the guard of the data preview; a table that fails is reported and the others go on.
 */
export async function syncToIceberg(request: SyncRequest, signal?: AbortSignal): Promise<SyncResult> {
  const { access, target, secret } = request;
  const hidden = [...secretsOf(access), ...(secret ? [secret] : [])];
  const report = request.report ?? (() => undefined);
  return withOpenLake({
    engine: await loadEngine(),
    access,
    signal,
    setup: setupStatements(access, undefined, undefined, icebergSetup(target, secret)),
    limitSetupOnly: true,
    cancelledText: 'The sync to Iceberg was cancelled.',
    activity: 'Attaching the lake and the Iceberg catalog',
    use: async ({ connection }) => {
      const rows = async (sql: string): Promise<unknown[][]> =>
        (await connection.runAndReadAll(sql)).getRowsJson();
      const newest = Number((await rows("SELECT max(snapshot_id) FROM ducklake_snapshots('lake')"))[0]?.[0]);
      const snapshot = access.snapshot ?? newest;
      const found = (
        await rows(`SELECT snapshot_time FROM ducklake_snapshots('lake') WHERE snapshot_id = ${snapshot}`)
      )[0]?.[0];
      const time = typeof found === 'string' ? found : undefined;
      const synced: TableSync[] = [];
      for (const [index, step] of request.steps.entries()) {
        signal?.throwIfAborted();
        report(`${step.record.schema}.${step.record.table} (${index + 1} of ${request.steps.length})`);
        synced.push(await syncTable(step));
      }
      return { snapshot, snapshotTime: time, tables: synced };

      async function syncTable(step: SyncStep): Promise<TableSync> {
        const lake = step.lake;
        if (!lake) return { step, status: 'failed', error: 'The table was dropped in the lake.' };
        const destination = icebergTable(icebergNameOfRecord(step));
        const source = `lake.${quoted(lake)} AT (VERSION => ${snapshot})`;
        try {
          if (step.mode === 'recreate' || step.mode === 'create') {
            await connection.run(
              `CREATE SCHEMA IF NOT EXISTS ${ICEBERG}.${quoteIdentifier(icebergNameOfRecord(step).namespace)}`,
            );
            await connection.run(`DROP TABLE IF EXISTS ${destination}`);
          }
          await connection.run('BEGIN TRANSACTION');
          try {
            await guardRelation(connection, lake, snapshot, {
              trusted: access.viewsTrusted,
              storage: access.storage?.config,
            });
            const described = await rows(`DESCRIBE SELECT * FROM ${source}`);
            const { list, converted } = selectList(
              described.map(([name, type]) => [String(name), String(type)]),
            );
            const written = await writeRows(step, lake, destination, source, list);
            await connection.run(
              `ALTER TABLE ${destination} SET (${originProperties(lake, snapshot, time)})`,
            );
            await connection.run('COMMIT');
            return {
              step,
              status: 'synced',
              rows: written,
              ...(converted.length === 0 ? {} : { converted }),
              icebergSnapshot: await icebergSnapshotOf(rows, destination),
            };
          } catch (failure) {
            await connection.run('ROLLBACK').catch(() => undefined);
            throw failure;
          }
        } catch (failure) {
          if (signal?.aborted) throw failure;
          return { step, status: 'failed', error: scrubbed(failure, hidden).line };
        }
      }

      /** Writes the rows of the step in the open transaction; returns how many. */
      async function writeRows(
        step: SyncStep,
        lake: TableRef,
        destination: string,
        source: string,
        list: string,
      ): Promise<number> {
        if (step.mode === 'append') {
          // The rows the lake inserted after the last sync, by their row ids, as they are at the snapshot of the sync.
          const changes = `lake.${quoteIdentifier(lake.schema)}.table_changes(${quoteLiteral(lake.table)}, ${step.record.snapshot + 1}, ${snapshot})`;
          const result = await connection.runAndReadAll(
            `INSERT INTO ${destination} SELECT ${list} FROM ${source} WHERE rowid IN (SELECT rowid FROM ${changes} WHERE change_type = 'insert')`,
          );
          // An expired snapshot hides its changes from the plan: when the counts differ, the rows are replaced instead.
          const counts = await rows(
            `SELECT (SELECT count(*) FROM ${destination}), (SELECT count(*) FROM ${source})`,
          );
          const [iceberg, inLake] = counts[0] ?? [];
          if (String(iceberg) === String(inLake)) return Number(result.rowsChanged);
        }
        if (step.mode === 'replace' || step.mode === 'append') {
          await connection.run(`DELETE FROM ${destination}`);
          const result = await connection.runAndReadAll(
            `INSERT INTO ${destination} SELECT ${list} FROM ${source}`,
          );
          return Number(result.rowsChanged);
        }
        const partitioned = request.partitions?.get(`${lake.schema}.${lake.table}`);
        const result = await connection.runAndReadAll(
          `CREATE TABLE ${destination}${partitioned === undefined ? '' : ` PARTITIONED BY (${partitioned})`} AS SELECT ${list} FROM ${source}`,
        );
        return Number(result.rowsChanged);
      }
    },
    fail: (cause, phase) => {
      if (cause instanceof AantjeError) return cause;
      const { line } = scrubbed(cause, hidden);
      return phase === 'extension'
        ? extensionFailure('A DuckDB extension that the Iceberg sync needs', line)
        : new AantjeError('CONNECTION_FAILED', `Cannot sync to Iceberg: ${line}`, { cause: new Error(line) });
    },
  });
}
