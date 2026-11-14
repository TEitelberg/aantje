import { isBelowDataPath } from '../catalog/locations';
import type { FileLocations, StoredFile } from '../catalog/model';
import { LakeFailure } from '../data/lake-session';
import type { LakeSession } from '../data/lake-session';
import {
  chooseDeepFiles,
  deepFindings,
  failureKind,
  footerStatement,
  schemaStatement,
  topLevelColumns,
  unreadableFinding,
} from './deep-checks';
import type { KnownColumns } from './deep-checks';
import type { HealthFinding } from './model';
import { fileKey } from './finding';
import { failureMessageOf } from '../data/lake-session';
import { PATH_MISSING } from './run-context';
import type { CatalogOutcome, RunContext } from './run-context';
import type { GroupResult } from './run-state';
import { missingFinding } from './storage-checks';

interface FileFacts {
  readonly rows: number;
  readonly columns: ReturnType<typeof topLevelColumns>;
}

/** Opens the Parquet footers of the files and compares them with the catalog. */
export async function runDeepGroup(
  ctx: RunContext,
  catalog: CatalogOutcome,
  session: LakeSession,
): Promise<void> {
  const { state } = ctx;
  if (ctx.request.depth !== 'deep') {
    state.skip('deep', 'Not part of the quick check.');
  } else if (state.has('connection.local-path-missing')) {
    state.skip('deep', PATH_MISSING);
  } else {
    state.setGroup({ group: 'deep', state: 'running' });
    state.setGroup({ group: 'deep', ...(await deepCheck(ctx, catalog, session)) });
  }
}

async function deepCheck(
  ctx: RunContext,
  catalog: CatalogOutcome,
  session: LakeSession,
): Promise<GroupResult> {
  if (catalog.latest === undefined) return { state: 'skipped', reason: 'The catalog could not be read.' };
  const reporter = limitedReporter(ctx);
  try {
    const places = await ctx.places(catalog.dataPath);
    // A catalog can name any path or URL; only files below the data path are opened, the rest count as not checked.
    const { chosen, eligible } = chooseDeepFiles(
      places.files.filter((file) => isBelowDataPath(file.location ?? '', places.dataPath)),
      ctx.limits.deepFiles,
    );
    const { opened, stopped } = await openFiles(ctx, catalog, session, chosen, reporter.report);
    if (!ctx.cancelled()) {
      ctx.state.emit({ type: 'progress', group: 'deep', done: opened, total: chosen.length });
    }
    const notChecked = notCheckedCount(ctx, places, opened);
    if (ctx.cancelled()) {
      return { state: 'skipped', reason: 'Cancelled.', ...(notChecked > 0 ? { notChecked } : {}) };
    }
    const omitted = reporter.omitted();
    return {
      state: stopped === undefined ? 'done' : 'failed',
      ...(stopped === undefined ? {} : { message: stopped }),
      ...(places.more || eligible > chosen.length ? { truncated: true as const } : {}),
      ...(omitted > 0 ? { omitted } : {}),
      ...(notChecked > 0 ? { notChecked } : {}),
    };
  } catch (error) {
    if (ctx.cancelled()) throw error;
    return { state: 'failed', message: failureMessageOf(error) };
  }
}

// Like the other groups: report the first findings of a check and count the rest.
function limitedReporter(ctx: RunContext): {
  report: (list: readonly HealthFinding[]) => void;
  omitted: () => number;
} {
  const reported = new Map<string, number>();
  let omitted = 0;
  return {
    report(list) {
      for (const item of list) {
        const count = reported.get(item.check) ?? 0;
        if (count < ctx.limits.findingsPerCheck) {
          reported.set(item.check, count + 1);
          ctx.state.add([item]);
        } else {
          omitted++;
        }
      }
    },
    omitted: () => omitted,
  };
}

// Opens files one by one until all are read, the run is cancelled or the store stops answering.
async function openFiles(
  ctx: RunContext,
  catalog: CatalogOutcome,
  session: LakeSession,
  chosen: readonly StoredFile[],
  report: (list: readonly HealthFinding[]) => void,
): Promise<{ opened: number; stopped: string | undefined }> {
  const known = new Map<number, KnownColumns>();
  let opened = 0;
  for (const [index, file] of chosen.entries()) {
    if (ctx.cancelled()) break;
    ctx.state.emit({ type: 'progress', group: 'deep', done: index, total: chosen.length });
    if (ctx.missingIds.has(fileKey(file))) continue;
    try {
      const facts = await readFooter(ctx, session, file);
      opened++;
      report(deepFindings(file, facts, await knownColumns(ctx, known, file.tableId), catalog.names));
    } catch (error) {
      if (ctx.cancelled()) break;
      if (!(error instanceof LakeFailure)) throw error;
      const outcome = deepFailure(ctx, catalog, error, file);
      if (outcome.stop !== undefined) return { opened, stopped: outcome.stop };
      opened++;
      report(outcome.findings);
    }
  }
  return { opened, stopped: undefined };
}

async function readFooter(ctx: RunContext, session: LakeSession, file: StoredFile): Promise<FileFacts> {
  const location = file.location ?? '';
  const footer = await session.rows(footerStatement(location), ctx.statementMs);
  const schema = await session.rows(schemaStatement(location), ctx.statementMs);
  return {
    rows: Number(footer[0]?.[0] ?? 0),
    columns: topLevelColumns(
      schema.map(([name, children, fieldId]) => [
        String(name),
        children === null || children === undefined ? null : Number(children),
        fieldId === null || fieldId === undefined ? null : Number(fieldId),
      ]),
    ),
  };
}

async function knownColumns(
  ctx: RunContext,
  cache: Map<number, KnownColumns>,
  tableId: number,
): Promise<KnownColumns> {
  let columns = cache.get(tableId);
  if (columns === undefined) {
    const history = await ctx.deps.reader.columnHistory(tableId, ctx.signal);
    columns = {
      ids: new Set(history.map((column) => column.id)),
      names: new Set(history.map((column) => column.name)),
    };
    cache.set(tableId, columns);
  }
  return columns;
}

// Files the storage check reported lost are known, not "not checked".
function notCheckedCount(ctx: RunContext, places: FileLocations, opened: number): number {
  const current = places.files.filter((file) => file.endSnapshot === null);
  return current.length - opened - current.filter((file) => ctx.missingIds.has(fileKey(file))).length;
}

function deepFailure(
  ctx: RunContext,
  catalog: CatalogOutcome,
  failure: LakeFailure,
  file: StoredFile,
): { findings: HealthFinding[]; stop?: string } {
  const { text } = failure;
  switch (failureKind(text, ctx.deps.access.storage?.config.kind)) {
    case 'busy':
      return {
        findings: [],
        stop: 'A statement did not end within its time limit; the remaining files were not opened.',
      };
    case 'store':
      return {
        findings: [],
        stop: 'The storage did not answer the request for a file (see the group Connection).',
      };
    case 'gone':
      // The storage check reports it; the deep check does when that did not run.
      return {
        findings: ctx.missingIds.has(fileKey(file))
          ? []
          : [missingFinding(file, catalog.names, catalog.latest ?? 0)],
      };
    case 'unreadable': {
      const first = failure.timedOut
        ? 'Reading the end of the file exceeded the time limit.'
        : (text.split(/\r?\n/)[0] ?? text);
      return { findings: [unreadableFinding(file, first, catalog.names)] };
    }
  }
}
