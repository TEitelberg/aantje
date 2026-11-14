import { isBelowDataPath } from '../catalog/locations';
import type { FileLocations } from '../catalog/model';
import type { LakeSession } from '../data/lake-session';
import { LakeFailure } from '../data/lake-session';
import { isRemote } from './connection-checks';
import { storageContextOf } from '../storage/diagnose';
import { tableScope } from './finding';
import { listingStatement } from '../data/store-sql';
import { compareStorage } from './storage-checks';
import type { ListedFile } from './storage-checks';
import { failureMessageOf } from '../data/lake-session';
import { PATH_MISSING } from './run-context';
import type { CatalogOutcome, RunContext } from './run-context';
import type { FindingScope, HealthScope } from './model';
import type { GroupResult } from './run-state';

function findingScopeOf(scope: HealthScope, catalog: CatalogOutcome): FindingScope {
  switch (scope.kind) {
    case 'table':
      return tableScope(scope.tableId, catalog.names);
    case 'schema':
      return {
        kind: 'schema',
        id: scope.schemaId,
        name: catalog.schemas.get(scope.schemaId) ?? `#${scope.schemaId}`,
      };
    case 'lake':
      return { kind: 'lake' };
  }
}

type ReadyCatalog = CatalogOutcome & { dataPath: string; latest: number };

const isReady = (catalog: CatalogOutcome): catalog is ReadyCatalog =>
  catalog.dataPath !== null && catalog.dataPath !== '' && catalog.latest !== undefined;

/** Compares the catalog's files with the files the store lists. */
export async function runStorageGroup(
  ctx: RunContext,
  catalog: CatalogOutcome,
  session: LakeSession,
): Promise<void> {
  ctx.state.setGroup({ group: 'storage', state: 'running' });
  ctx.state.setGroup({ group: 'storage', ...(await storageCheck(ctx, catalog, session)) });
}

async function storageCheck(
  ctx: RunContext,
  catalog: CatalogOutcome,
  session: LakeSession,
): Promise<GroupResult> {
  if (!isReady(catalog)) {
    return { state: 'skipped', reason: 'The catalog has no data path.' };
  }
  if (ctx.state.has('connection.local-path-missing')) return { state: 'skipped', reason: PATH_MISSING };
  try {
    const places = await ctx.places(catalog.dataPath);
    const target = listingTarget(ctx, places);
    if ('state' in target) return target;
    const listing = await listFiles(ctx, session, target.directory);
    return compareListing(ctx, catalog, places, target.directory, listing);
  } catch (error) {
    if (ctx.cancelled()) throw error;
    return { state: 'failed', message: listingFailure(ctx, error) };
  }
}

function compareListing(
  ctx: RunContext,
  catalog: ReadyCatalog,
  places: FileLocations,
  directory: string,
  listing: readonly ListedFile[],
): GroupResult {
  const { storageFiles } = ctx.limits;
  const cut = listing.length > storageFiles;
  const kept = cut ? listing.slice(0, storageFiles) : listing;
  const result = compareStorage({
    files: places.files,
    scheduled: places.scheduled,
    shared: places.shared,
    listing: kept,
    directory,
    scope: findingScopeOf(ctx.request.scope, catalog),
    ...(cut ? { cutAfter: kept.at(-1)?.key ?? '' } : {}),
    names: catalog.names,
    latest: catalog.latest,
    now: ctx.now(),
    limit: ctx.limits.findingsPerCheck,
    caseInsensitive:
      ctx.deps.caseInsensitive ?? (!isRemote(catalog.dataPath) && process.platform === 'win32'),
    storage: storageContextOf(ctx.deps.access.storage),
  });
  ctx.state.add(result.findings);
  for (const id of result.missing) ctx.missingIds.add(id);
  return {
    state: 'done',
    ...(cut || places.moreScheduled ? { truncated: true as const } : {}),
    ...(result.omitted > 0 ? { omitted: result.omitted } : {}),
    ...(result.notChecked > 0 ? { notChecked: result.notChecked } : {}),
  };
}

// The directory to list, or why the group does not run.
function listingTarget(ctx: RunContext, places: FileLocations): { directory: string } | GroupResult {
  if (places.more) {
    return {
      state: 'skipped',
      truncated: true,
      reason: `The catalog lists more than ${ctx.limits.storageFiles.toLocaleString('en-US')} files for this scope, more than one run compares. Check a single table instead.`,
    };
  }
  const { kind } = ctx.request.scope;
  const directory = kind === 'lake' ? places.dataPath : places.directory;
  if (directory === null) {
    return { state: 'skipped', reason: `The ${kind} has no directory in the catalog.` };
  }
  if (kind !== 'lake' && !isBelowDataPath(directory, places.dataPath)) {
    return {
      state: 'skipped',
      reason: `The directory of the ${kind} lies outside the data path, so it is not listed.`,
    };
  }
  return { directory };
}

async function listFiles(ctx: RunContext, session: LakeSession, directory: string): Promise<ListedFile[]> {
  const rows = await session.rows(listingStatement(directory, ctx.limits.storageFiles), ctx.statementMs);
  return rows.map(([key, size, modified]) => ({
    key: String(key),
    size: Number(size),
    modified: Number(modified),
  }));
}

function listingFailure(ctx: RunContext, error: unknown): string {
  if (error instanceof LakeFailure && error.timedOut) {
    return `Listing the object store exceeded the time limit of ${Math.round(ctx.statementMs / 1000)} s (aantje.queryTimeoutSeconds). Check a single table instead.`;
  }
  return failureMessageOf(error);
}
