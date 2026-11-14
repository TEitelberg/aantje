import type { CatalogInfo } from '../catalog/model';
import type { OpenedCatalog } from '../catalog/open';
import { globalValue } from '../catalog/model';
import { secretsOf } from '../data/errors';
import { LakeFailure, withLakeSession } from '../data/lake-session';
import { probeStatement } from '../data/store-sql';
import type { DataAccess } from '../data/types';
import { AantjeError, isAantjeError, userMessageOf } from '../errors';
import { maskSecrets } from '../secrets';
import { locate } from '../storage/location';

/** What a connection test found: the catalog, its data path, and whether the storage was asked. */
export interface TestedConnection extends CatalogInfo {
  /** The `data_path` of the lake; null when the catalog has none. */
  readonly dataPath?: string | null;
  /** `reachable`: the storage answered; `skipped`: a local data path, nothing to sign in to. */
  readonly storage?: 'reachable' | 'skipped';
}

/** Asks the object store below `dataPath` for one answer through the engine; rejects with a `LakeFailure`. */
export type StorageProbe = (access: DataAccess, dataPath: string) => Promise<void>;

/** A cheap listing under the data path (the probe of the health check): it matches nothing, but signs in and reaches the store. */
export const probeStorage: StorageProbe = async (access, dataPath) => {
  await withLakeSession(access, undefined, async (session) => {
    await session.rows(probeStatement(dataPath), access.timeoutMs);
  });
};

export interface ConnectionTestDeps {
  /** Opens the catalog; the caller closes nothing, the test closes the reader. */
  open(): Promise<OpenedCatalog>;
  /** The access the engine uses for the storage; built after the catalog opened. */
  access(): Promise<DataAccess>;
  readonly probe?: StorageProbe;
  /** False for a connection whose server reads the data files (Quack): there is no storage of aantje to test. */
  readonly storage?: boolean;
}

/**
 * Tests a connection in two parts and says which one failed. First the catalog opens; then, for a data path that is not
 * local, the engine attaches the lake and asks the storage for one listing. Engine messages are masked with the secrets
 * of the access. A failure of the catalog keeps its error code.
 */
export async function testCatalogAndStorage(deps: ConnectionTestDeps): Promise<TestedConnection> {
  let info: CatalogInfo;
  let dataPath: string | null;
  try {
    const opened = await deps.open();
    try {
      info = opened.info;
      dataPath = globalValue(await opened.reader.metadata(), 'data_path');
    } finally {
      await opened.reader.close();
    }
  } catch (error) {
    throw isAantjeError(error)
      ? new AantjeError(error.code, `The catalog cannot be opened: ${error.userMessage}`, { cause: error })
      : error;
  }
  const tested: TestedConnection = { ...info, dataPath };
  if (
    deps.storage === false ||
    dataPath === null ||
    dataPath.trim() === '' ||
    locate(dataPath).family === 'local'
  ) {
    return { ...tested, storage: 'skipped' };
  }
  let access: DataAccess | undefined;
  try {
    access = await deps.access();
    await (deps.probe ?? probeStorage)(access, dataPath);
  } catch (error) {
    throw storageFailure(error, access);
  }
  return { ...tested, storage: 'reachable' };
}

// Setting up the engine (extension, secret, attach) is the sign-in; the listing is the store itself.
function storageFailure(error: unknown, access: DataAccess | undefined): AantjeError {
  const secrets = access ? secretsOf(access) : [];
  if (error instanceof LakeFailure) {
    const text = maskSecrets(error.message, secrets);
    const where =
      error.phase === 'query'
        ? 'the storage did not answer'
        : 'the engine could not set up the storage sign-in or attach the lake';
    return new AantjeError(
      error.timedOut ? 'TIMEOUT' : 'CONNECTION_FAILED',
      `The catalog works, but ${where}: ${text}`,
      { cause: error },
    );
  }
  const text = isAantjeError(error) ? maskSecrets(userMessageOf(error), secrets) : userMessageOf(error);
  return new AantjeError('CONNECTION_FAILED', `The catalog works, but the storage sign-in failed: ${text}`, {
    cause: error,
  });
}

/** The line after a successful test. */
export function successText(name: string, tested: TestedConnection): string {
  const storage =
    tested.storage === 'reachable'
      ? ' The storage is reachable.'
      : tested.storage === 'skipped'
        ? ' The data path is local, so no storage was tested.'
        : '';
  return `The connection "${name}" works. DuckLake spec version ${tested.specVersion}, latest snapshot ${tested.latestSnapshot}.${storage}`;
}
