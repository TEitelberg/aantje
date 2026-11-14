import { stat } from 'node:fs/promises';
import { isNetworkPath } from '../catalog/locations';
import { newestSnapshotQuery } from '../data/attach';
import { EXTENSION_HINT } from '../duckdb/messages';
import { LakeFailure } from '../data/lake-session';
import type { LakeSession } from '../data/lake-session';
import { configFindings, endpointNotSet, isRemote, setupFailure, storeFailure } from './connection-checks';
import type { ConnectionFacts } from './connection-checks';
import { finding } from './finding';
import { failureMessageOf } from '../data/lake-session';
import type { CatalogOutcome, RunContext } from './run-context';
import { probeStatement } from '../data/store-sql';
import { s3SettingsOf } from '../storage/resolve';
import { signInExpiryOf, signInSourceOf, storageFactsOf } from './storage-facts';

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    // An unreadable directory counts as missing.
    return false;
  }
}

/**
 * The facts the connection checks use: catalog data path, the storage of the connection (kinds and names, no secret
 * value) and where its sign-in comes from. `credentialsFrom` only words a connection on the machine's S3 settings.
 */
export function connectionFacts(ctx: RunContext, catalog: CatalogOutcome): ConnectionFacts {
  const { deps } = ctx;
  const { storage } = deps.access;
  const facts = storageFactsOf(storage);
  const expires = signInExpiryOf(storage);
  return {
    dataPath: catalog.dataPath,
    ...(facts === undefined ? {} : { storage: facts }),
    s3: s3SettingsOf(storage),
    credentials: signInSourceOf(storage, deps.credentialsFrom),
    ...(expires === undefined ? {} : { signInExpires: expires }),
    env: deps.env ?? {},
  };
}

/** Starts the connection group with the checks that need no engine: unreadable catalog and settings. */
export async function startConnectionGroup(
  ctx: RunContext,
  catalog: CatalogOutcome,
  facts: ConnectionFacts,
): Promise<void> {
  const { state } = ctx;
  state.setGroup({ group: 'connection', state: 'running' });
  if (catalog.error !== undefined) {
    state.add([
      finding('connection.catalog-unreachable', {
        severity: 'error',
        scope: { kind: 'lake' },
        title: 'The catalog database cannot be read',
        detail: catalog.error,
        cause:
          'The server or file of the catalog is not reachable with the settings of the connection, the login or the TLS check failed, or the database is locked.',
        fix: 'Check the connection (server, port, database, user, password, TLS) in the connection settings and that the database is up.',
      }),
    ]);
  }
  const { dataPath } = catalog;
  // `stat` of a network path (`\\host\share`) would contact the host from the extension host without the engine, for
  // a data path that the catalog chose; the engine lists it in the storage group instead.
  const localDirectory =
    dataPath !== null && dataPath !== '' && !isRemote(dataPath) && !isNetworkPath(dataPath)
      ? dataPath
      : undefined;
  const localExists =
    localDirectory === undefined ? undefined : await (ctx.deps.exists ?? directoryExists)(localDirectory);
  state.add(configFindings(facts, localExists, ctx.now()));
}

/** Finishes the connection group by asking the lake and the object store. Returns why later groups cannot run, or undefined. */
export async function checkConnection(
  ctx: RunContext,
  facts: ConnectionFacts,
  session: LakeSession,
): Promise<string | undefined> {
  const { state, statementMs } = ctx;
  try {
    await session.rows(newestSnapshotQuery(), statementMs);
  } catch (error) {
    state.add([setupFailure('setup', failureText(error), EXTENSION_HINT)]);
    state.setGroup({ group: 'connection', state: 'done' });
    return 'The lake could not be read after the attach (see the group Connection).';
  }
  const { dataPath } = facts;
  if (dataPath !== null && dataPath !== '' && isRemote(dataPath)) {
    try {
      await session.rows(probeStatement(dataPath), statementMs);
    } catch (error) {
      const failed = storeFailure(failureText(error), error instanceof LakeFailure && error.timedOut, facts);
      const hint = endpointNotSet(failed, facts);
      state.add(hint ? [hint, failed] : [failed]);
      state.setGroup({ group: 'connection', state: 'done' });
      return 'The storage did not answer (see the group Connection).';
    }
  }
  state.setGroup({ group: 'connection', state: 'done' });
  return undefined;
}

/** Ends the connection group with the finding for an engine setup failure (extension, attach). */
export function reportSetupFailure(ctx: RunContext, error: unknown): string {
  const failure = error instanceof LakeFailure ? error : undefined;
  ctx.state.add([setupFailure(failure?.phase ?? 'setup', failureText(error), EXTENSION_HINT)]);
  ctx.state.setGroup({ group: 'connection', state: 'done' });
  return 'The lake could not be attached (see the group Connection).';
}

const failureText = (error: unknown): string =>
  error instanceof LakeFailure ? error.text : failureMessageOf(error);
