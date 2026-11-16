import { globalValue } from '../catalog/model';
import type { CatalogReader } from '../catalog/model';
import { effectiveStorage } from '../connections/profile';
import type { ConnectionProfile } from '../connections/profile';
import type { ResolvedStorage } from '../storage/config';
import type { ChainDeps } from './azure-chain';
import { createAzureTokens } from './azure-token';
import type { Http } from './http';
import { listLevel } from './listing';
import type { Hidden, Level, ListingDeps } from './listing';
import { asDirectory, defaultRoot, directoryKey, localPath, rootProblem, splitRemote } from './place';
import type { S3Keys } from './sigv4';

// What the tree asks of the Files folder of a connection: its roots, read once from the catalog and the profile, and one
// level below a root, listed with the storage access of the connection (#20: `resolveStorage`).

/** What the levels of one Files folder share: the data path and the directories to leave out. */
export interface FilesContext {
  readonly dataPath: string | null;
  readonly hidden: Hidden;
}

export interface FileRoot {
  /** The root as a directory: an object-store path ending in `/`, a local path ending in its separator. */
  readonly path: string;
  /** Why it is not listed with this connection; undefined when it is. */
  readonly problem?: string;
}

export interface FilesRoots {
  readonly context: FilesContext;
  readonly roots: readonly FileRoot[];
  /** Why there is no root at all; set when `roots` is empty. */
  readonly empty?: string;
}

/** The Files folder as the tree uses it. */
export interface FilesPort {
  roots(profile: ConnectionProfile, reader: CatalogReader, signal?: AbortSignal): Promise<FilesRoots>;
  level(
    profile: ConnectionProfile,
    context: FilesContext,
    root: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<Level>;
}

export interface FilesDeps {
  /** The storage of a connection with its sign-in values (`resolveStorage` of #20); undefined when it has none. */
  storage(profile: ConnectionProfile): Promise<ResolvedStorage | undefined>;
  readonly http?: Http;
  /** The limit of one request, in ms. */
  readonly timeoutMs?: () => number;
  readonly now?: () => Date;
  /** Resolves an AWS credential chain to keys through the engine. */
  readonly chainKeys?: (storage: ResolvedStorage) => Promise<{ keys: S3Keys; region?: string } | undefined>;
  /** Registers a value for the masking of the log: every client secret, assertion and token the folder uses. */
  readonly register?: (value: string) => void;
  /** Where the Entra tokens of Azure and OneLake come from; the tests point them at fakes. */
  readonly azure?: Omit<ChainDeps, 'http' | 'register' | 'timeoutMs'>;
}

// Keys of a credential chain are reused for a while, so that every expanded folder does not start an engine.
const CHAIN_KEYS_MS = 5 * 60_000;

const NO_DATA_PATH = 'The catalog has no data path. Set "fileRoots" in Edit Connection to browse a folder.';
const UNLISTED =
  'The data path lies on a storage that the Files folder does not list (it lists a local disk, S3 and S3-compatible stores, Azure and OneLake). Set "fileRoots" in Edit Connection to browse a folder.';

/** A root as the tree keeps it: object-store paths in the form `locate` writes, local paths as paths of the disk. */
function asRoot(path: string): string {
  return splitRemote(path) ? asDirectory(path) : asDirectory(localPath(path) ?? path);
}

export function createFilesSource(deps: FilesDeps): FilesPort {
  const chains = new Map<string, { at: number; keys: ReturnType<NonNullable<FilesDeps['chainKeys']>> }>();
  const chainKeys = deps.chainKeys;
  // Read at each request, as the editor may wrap the global fetch after the start.
  const http: Http = (input, init) => (deps.http ?? fetch)(input, init);
  const azureTokens = createAzureTokens({
    ...(deps.now ? { now: deps.now } : {}),
    ...deps.azure,
    http,
    register: deps.register ?? (() => undefined),
  });
  const listing = (connectionId: string): ListingDeps => ({
    http: deps.http ?? fetch,
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs() } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    azureToken: (storage: ResolvedStorage) => azureTokens(connectionId, storage, deps.timeoutMs?.()),
    ...(chainKeys
      ? {
          chainKeys: (storage: ResolvedStorage) => {
            const id = JSON.stringify(storage.config);
            const now = Date.now();
            const cached = chains.get(id);
            if (cached && now - cached.at < CHAIN_KEYS_MS) return cached.keys;
            const keys = chainKeys(storage);
            chains.set(id, { at: now, keys });
            // A failed resolution is tried again by the next listing.
            keys.catch(() => chains.delete(id));
            return keys;
          },
        }
      : {}),
  });

  return {
    async roots(profile, reader, signal) {
      const dataPath = globalValue(await reader.metadata(), 'data_path');
      const storage = effectiveStorage(profile);
      const account = storage?.kind === 'azure' ? storage.account : undefined;
      const owned = dataPath === null ? [] : await reader.storedDirectories(dataPath, signal);
      const keys = new Set(
        [dataPath ?? '', ...owned].flatMap((path) => {
          const key = path === '' ? undefined : directoryKey(path, account);
          return key === undefined ? [] : [key];
        }),
      );
      const context: FilesContext = { dataPath, hidden: { keys, ...(account ? { account } : {}) } };
      const own = profile.kind === 'quack' ? [] : (profile.fileRoots ?? []);
      if (own.length > 0) {
        return {
          context,
          roots: own.map((path) => {
            const problem = rootProblem(path, dataPath, storage);
            return { path: asRoot(path), ...(problem === undefined ? {} : { problem }) };
          }),
        };
      }
      if (dataPath === null || dataPath.trim() === '') return { context, roots: [], empty: NO_DATA_PATH };
      const root = defaultRoot(dataPath);
      if (root === undefined) return { context, roots: [], empty: UNLISTED };
      // The data path is the catalog's word: its root is held to the storage of the connection like any other.
      const problem = rootProblem(root, dataPath, storage);
      return { context, roots: [{ path: asRoot(root), ...(problem === undefined ? {} : { problem }) }] };
    },

    async level(profile, context, root, directory, signal) {
      return listLevel(
        root,
        directory,
        await deps.storage(profile),
        context.hidden,
        listing(profile.id),
        signal,
      );
    },
  };
}
