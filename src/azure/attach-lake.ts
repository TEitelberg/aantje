import { quoteLiteral } from '../catalog/ddl';
import { setupStatements } from '../data/attach';
import { secretsOf } from '../data/errors';
import { withOpenLake } from '../data/open-lake';
import type { DataAccess } from '../data/types';
import { loadEngine } from '../duckdb/engine';
import { locate } from '../storage/location';
import { extensionFailure, scrubbed } from '../duckdb/messages';
import { AantjeError, userMessageOf } from '../errors';
import type { Logger } from '../log';
import { isRolePropagation, withBackoff } from './retry';

export interface AttachDeps {
  readonly sleep: (ms: number) => Promise<void>;
  readonly report: (step: string) => void;
  readonly log: Pick<Logger, 'warn'>;
}

/**
 * The container of a data path as a glob: listing it needs a data role on the account and reads nothing. Exported for
 * its test.
 */
export function containerGlob(dataPath: string): string {
  return `${locate(dataPath).root}*`;
}

/**
 * Attaches a new lake for the first time, which makes DuckLake create its schema in the catalog and keep the data path.
 * Then it lists the container, so that a role that has not taken effect yet shows now and not at the first query; both
 * are tried again, with growing waits, while the failure looks like a role that is still spreading.
 */
export async function attachNewLake(access: DataAccess, dataPath: string, deps: AttachDeps): Promise<void> {
  const engine = await loadEngine();
  const attempt = (): Promise<void> =>
    withOpenLake({
      engine,
      access,
      signal: undefined,
      setup: setupStatements(access, { readOnly: false, dataPath }),
      cancelledText: 'Attaching the new lake was cancelled.',
      activity: 'Attaching the new lake',
      use: async ({ connection }) => {
        // A local data path has no container to list.
        if (locate(dataPath).family !== 'local') {
          await connection.run(`SELECT count(*) FROM glob(${quoteLiteral(containerGlob(dataPath))})`);
        }
      },
      fail: (cause, phase) => {
        const { line } = scrubbed(cause, secretsOf(access));
        return phase === 'extension'
          ? extensionFailure('A DuckDB extension that the lake needs', line)
          : new AantjeError('CONNECTION_FAILED', `Cannot attach the new lake: ${line}`, {
              cause: new Error(line),
            });
      },
    });
  await withBackoff(attempt, {
    isRetryable: isRolePropagation,
    sleep: deps.sleep,
    onRetry: (number, error) => {
      deps.report(`Waiting for the access to the storage account to take effect (try ${number})`);
      deps.log.warn(
        `The access to the storage account has not taken effect yet (try ${number}): ${userMessageOf(error)}`,
      );
    },
  });
}
