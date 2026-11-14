import type { CatalogReader, FileLocations, HealthScopeRef, SnapshotId } from '../catalog/model';
import type { DataAccess } from '../data/types';
import type { TableNames } from './finding';
import { DEFAULT_LIMITS } from './model';
import type { HealthEvent, HealthLimits, HealthRequest, HealthScope } from './model';
import { createRunState } from './run-state';
import type { RunState } from './run-state';

// The per-statement time limit when the settings give none.
const STATEMENT_MS = 30_000;

/** Why storage and deep checks skip when the local data path is gone. */
export const PATH_MISSING = 'The data path does not exist on this machine (see the group Connection).';

/** What the check needs from its surroundings. */
export interface HealthDeps {
  readonly reader: CatalogReader;
  /** `timeoutMs` limits each statement. */
  readonly access: DataAccess;
  /** Source of the machine's S3 credentials of `access` (a connection without storage), which words the advice; stored if not given. */
  readonly credentialsFrom?: 'stored' | 'environment';
  /** Tests set the clock. */
  readonly now?: () => Date;
  /** Defaults to asking the extension host's file system. */
  readonly exists?: (path: string) => Promise<boolean>;
  /** Compare file names ignoring case; defaults to true for a local data path on Windows. */
  readonly caseInsensitive?: boolean;
  /** The extension host environment; an S3 endpoint it names is suggested when none is set. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface HealthRun {
  readonly signal?: AbortSignal;
  /** Called in order for every group change, finding and the summary. */
  readonly onEvent?: (event: HealthEvent) => void;
}

/** What the catalog group finds out for the later groups. */
export interface CatalogOutcome {
  latest: SnapshotId | undefined;
  dataPath: string | null;
  names: TableNames;
  /** The schemas of the newest snapshot by id. */
  schemas: ReadonlyMap<number, string>;
  /** Undefined when the catalog was read. */
  error: string | undefined;
}

export interface RunContext {
  readonly deps: HealthDeps;
  readonly request: HealthRequest;
  readonly limits: HealthLimits;
  readonly statementMs: number;
  readonly signal: AbortSignal | undefined;
  readonly scopeRef: HealthScopeRef;
  readonly state: RunState;
  /** Files the storage check found lost, as `kind:id`; the deep check skips them. */
  readonly missingIds: Set<string>;
  now(): Date;
  cancelled(): boolean;
  /** Read once per run, with the data path the catalog group read. */
  places(dataPath: string | null): Promise<FileLocations>;
}

function scopeRefOf(scope: HealthScope): HealthScopeRef {
  switch (scope.kind) {
    case 'table':
      return { tableId: scope.tableId };
    case 'schema':
      return { schemaId: scope.schemaId };
    case 'lake':
      return {};
  }
}

export function createRunContext(deps: HealthDeps, request: HealthRequest, run: HealthRun): RunContext {
  const limits: HealthLimits = { ...DEFAULT_LIMITS, ...request.limits };
  const scopeRef = scopeRefOf(request.scope);
  const { signal } = run;
  let locations: Promise<FileLocations> | undefined;
  return {
    deps,
    request,
    limits,
    statementMs: deps.access.timeoutMs ?? STATEMENT_MS,
    signal,
    scopeRef,
    state: createRunState(run.onEvent),
    missingIds: new Set(),
    now: deps.now ?? ((): Date => new Date()),
    cancelled: () => signal?.aborted === true,
    places: (dataPath) =>
      (locations ??= deps.reader.fileLocations(scopeRef, dataPath, limits.storageFiles, signal)),
  };
}
