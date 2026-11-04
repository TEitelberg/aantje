import { quoteLiteral } from '../catalog/ddl';
import { setupStatements } from '../data/attach';
import { EXTENSION_HINT, firstLine, secretsOf } from '../data/errors';
import { guardedOpen, loadEngine } from '../data/open-lake';
import type { DataAccess } from '../data/types';
import { AantjeError, messageOf, userMessageOf } from '../errors';
import type { Logger } from '../log';
import { maskSecrets } from '../secrets';
import { isRolePropagation, withBackoff } from './retry';

export interface AttachDeps {
  readonly sleep: (ms: number) => Promise<void>;
  readonly report: (step: string) => void;
  readonly log: Pick<Logger, 'warn'>;
}

/** The container of a data path as a glob: listing it needs a data role on the account and reads nothing. */
export function containerGlob(dataPath: string): string {
  const { protocol, username, host } = new URL(dataPath);
  return `${protocol}//${username}@${host}/*`;
}

/**
 * Attaches a new lake for the first time, which makes DuckLake create its schema in the catalog and keep the data path.
 * Then it lists the container, so that a role that has not taken effect yet shows now and not at the first query; both
 * are tried again, with growing waits, while the failure looks like a role that is still spreading.
 */
export async function attachNewLake(access: DataAccess, dataPath: string, deps: AttachDeps): Promise<void> {
  const engine = await loadEngine();
  const attempt = (): Promise<void> =>
    guardedOpen({
      engine,
      access,
      signal: undefined,
      setup: setupStatements(access, { readOnly: false, dataPath }),
      cancelledText: 'Attaching the new lake was cancelled.',
      activity: 'Attaching the new lake',
      use: async ({ connection }) => {
        await connection.run(`SELECT count(*) FROM glob(${quoteLiteral(containerGlob(dataPath))})`);
      },
      fail: (cause, phase) => {
        const text = firstLine(maskSecrets(messageOf(cause), secretsOf(access)));
        return new AantjeError(
          'CONNECTION_FAILED',
          phase === 'extension'
            ? `A DuckDB extension that the lake needs could not be installed or loaded (${text}). ${EXTENSION_HINT}`
            : `Cannot attach the new lake: ${text}`,
          { cause: new Error(text) },
        );
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
