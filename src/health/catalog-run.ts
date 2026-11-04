import { globalValue } from '../catalog/model';
import type { CatalogEntry, SnapshotId } from '../catalog/model';
import { isAantjeError } from '../errors';
import { catalogFindings } from './catalog-checks';
import { finding } from './finding';
import type { TableNames } from './finding';
import type { GroupStatus, HealthFinding } from './model';
import { failureMessageOf } from './run-context';
import type { CatalogOutcome, RunContext } from './run-context';

// Rows read per consistency check; a finding's detail names the first few.
const SAMPLES = 10;

type Reads = Awaited<ReturnType<typeof readCatalog>>;

/** Reads the catalog, reports its problems and returns what the other groups need. */
export async function runCatalogGroup(ctx: RunContext): Promise<CatalogOutcome> {
  const facts: CatalogOutcome = {
    latest: undefined,
    dataPath: null,
    names: new Map(),
    schemas: new Map(),
    error: undefined,
  };
  ctx.state.setGroup({ group: 'catalog', state: 'running' });
  try {
    await checkCatalog(ctx, facts);
  } catch (error) {
    catalogFailed(ctx, facts, error);
  }
  return facts;
}

async function readCatalog(ctx: RunContext, newest: SnapshotId) {
  const { limits, request, scopeRef, signal } = ctx;
  const { reader } = ctx.deps;
  const metadataRead = reader.metadata();
  const [metadata, snapshotCount, scheduled, consistency, maintenance, entries, viewed, schemas] =
    await Promise.allSettled([
      metadataRead,
      reader.snapshotCount(),
      reader.scheduledForDeletion(metadataRead),
      reader.consistency(scopeRef, newest, SAMPLES, signal),
      reader.maintenanceFacts(scopeRef, limits.findingsPerCheck + 1, signal),
      reader.entries(newest),
      request.scope.kind === 'table' && request.snapshot !== newest
        ? reader.entries(request.snapshot)
        : Promise.resolve([]),
      reader.schemas(newest),
    ]);
  const failures = [
    metadata,
    snapshotCount,
    scheduled,
    consistency,
    maintenance,
    entries,
    viewed,
    schemas,
  ].flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));
  return { metadata, snapshotCount, scheduled, consistency, maintenance, entries, viewed, schemas, failures };
}

// A table scope names the table as the snapshot in view does, else as the newest one.
function listedEntries(reads: Reads): CatalogEntry[] {
  const listed = (result: PromiseSettledResult<readonly CatalogEntry[]>): readonly CatalogEntry[] =>
    result.status === 'fulfilled' ? result.value : [];
  return [...listed(reads.entries), ...listed(reads.viewed)];
}

function tableNames(entries: readonly CatalogEntry[]): TableNames {
  return new Map(
    entries
      .filter((entry) => entry.kind === 'table')
      .map((entry) => [entry.id, { schema: entry.schemaName, name: entry.name }]),
  );
}

async function checkCatalog(ctx: RunContext, facts: CatalogOutcome): Promise<void> {
  const { state, limits, request } = ctx;
  const info = await ctx.deps.reader.info();
  const newest = info.latestSnapshot;
  facts.latest = newest;
  const reads = await readCatalog(ctx, newest);
  if (ctx.cancelled()) throw new Error('cancelled');
  const listed = listedEntries(reads);
  facts.names = tableNames(listed);
  // Also a schema without a table or view: its findings and its auto_compact option need the name.
  const named = reads.schemas.status === 'fulfilled' ? reads.schemas.value : [];
  facts.schemas = new Map([
    ...listed.map((entry): [number, string] => [entry.schemaId, entry.schemaName]),
    ...named.map((schema): [number, string] => [schema.id, schema.name]),
  ]);
  const { metadata, snapshotCount, scheduled, consistency, maintenance } = reads;
  if (metadata.status === 'fulfilled') facts.dataPath = globalValue(metadata.value, 'data_path');
  const result = catalogFindings({
    now: ctx.now(),
    scope: request.scope,
    latest: newest,
    tables: facts.names,
    specVersion: info.specVersion,
    dataPath: facts.dataPath,
    snapshotCount: snapshotCount.status === 'fulfilled' ? snapshotCount.value : 0,
    limit: limits.findingsPerCheck,
    schemas: facts.schemas,
    ...(metadata.status === 'fulfilled' ? { metadata: metadata.value } : {}),
    ...(consistency.status === 'fulfilled' ? { consistency: consistency.value } : {}),
    ...(maintenance.status === 'fulfilled' ? { maintenance: maintenance.value } : {}),
    ...(scheduled.status === 'fulfilled' ? { scheduled: scheduled.value } : {}),
  });
  state.add(result.findings);
  const unavailable = consistency.status === 'fulfilled' ? consistency.value.unavailable.length : 0;
  const status: GroupStatus = {
    group: 'catalog',
    state: reads.failures.length > 0 ? 'failed' : 'done',
    ...(reads.failures.length > 0 ? { message: failureMessageOf(reads.failures[0]) } : {}),
    ...(result.truncated ? { truncated: true as const } : {}),
    ...(result.omitted > 0 ? { omitted: result.omitted } : {}),
    ...(unavailable > 0 ? { notChecked: unavailable } : {}),
  };
  state.setGroup(status);
}

function catalogFailed(ctx: RunContext, facts: CatalogOutcome, error: unknown): void {
  const { state } = ctx;
  if (ctx.cancelled()) {
    state.skip('catalog', 'Cancelled.');
  } else if (
    isAantjeError(error) &&
    (error.code === 'UNSUPPORTED_VERSION' || error.code === 'NOT_A_DUCKLAKE')
  ) {
    state.add([unsupportedCatalog(error.code, error.userMessage)]);
    state.setGroup({ group: 'catalog', state: 'done' });
  } else {
    facts.error = failureMessageOf(error);
    state.setGroup({ group: 'catalog', state: 'failed', message: facts.error });
  }
}

function unsupportedCatalog(code: string, detail: string): HealthFinding {
  return finding('catalog.spec-version', {
    severity: 'error',
    scope: { kind: 'lake' },
    title: 'The catalog is not a DuckLake catalog that aantje supports',
    detail,
    cause:
      code === 'UNSUPPORTED_VERSION'
        ? 'The catalog was written for another major version of the DuckLake specification.'
        : 'The database is no DuckLake catalog, or its tables cannot be read.',
    fix: 'Open the catalog database of a DuckLake of specification 1.x. aantje reads catalogs and does not migrate them.',
  });
}
