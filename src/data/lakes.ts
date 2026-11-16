import type * as Duckdb from '@duckdb/node-api';
import { loadEngine } from '../duckdb/engine';
import { AantjeError, messageOf } from '../errors';
import { maskSecrets } from '../secrets';
import { lakesSetup } from './attach';
import type { AttachedLake } from './attach';
import { dataError, secretsOf } from './errors';
import { guardRelation } from './guard';
import { withOpenLake } from './open-lake';
import type { TableRef } from './types';

/** A lake of an engine with several, and the tables of it that the work reads. */
export interface LakeSide extends AttachedLake {
  readonly tables: readonly TableRef[];
}

/**
 * Runs `use` in one private, read-only in-memory DuckDB with every lake attached at the snapshot of its access, under
 * its alias, after the checks of a read of each table, in one transaction (`withLake` in `engine.ts` reads one lake).
 * Each lake's secrets have names of their own and its storage secret is limited to its data path (`lakesSetup`). The
 * attach is limited by `timeoutMs`; `use` runs until it ends or `signal` fires. Views are not read.
 */
export async function withLakes<T>(
  sides: readonly LakeSide[],
  signal: AbortSignal | undefined,
  activity: string,
  use: (connection: Duckdb.DuckDBConnection) => Promise<T>,
): Promise<T> {
  const [first] = sides;
  if (first === undefined) {
    throw new AantjeError('QUERY_FAILED', `${activity} needs a lake.`);
  }
  // A message of the engine may name any lake's secret: mask them all before one side words the error.
  const secrets = sides.flatMap((side) => secretsOf(side.access));
  return withOpenLake({
    engine: await loadEngine(),
    access: first.access,
    signal,
    setup: lakesSetup(sides),
    limitSetupOnly: true,
    cancelledText: `${activity} was cancelled.`,
    activity,
    use: async ({ connection }) => {
      await connection.run('BEGIN TRANSACTION');
      try {
        for (const side of sides) {
          for (const table of side.tables) {
            await guardRelation(connection, table, side.access.snapshot, {
              trusted: false,
              storage: side.access.storage?.config,
              alias: side.alias,
            });
          }
        }
        return await use(connection);
      } finally {
        await connection.run('ROLLBACK').catch(() => undefined);
      }
    },
    fail: (cause, phase) => {
      if (cause instanceof AantjeError) {
        return cause;
      }
      const message = maskSecrets(messageOf(cause), secrets);
      // The side whose alias the message names, else the first.
      const side = sides.find((candidate) => message.includes(candidate.alias)) ?? first;
      const table = side.tables[0] ?? { schema: '', table: '' };
      return dataError(new Error(message), phase, side.access, table);
    },
  });
}
