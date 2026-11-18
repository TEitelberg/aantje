// Sync to Iceberg of what was synced before: the plan from the lake's changes and the last check, a question that says
// what will happen, the sync, and the records moved to the new snapshot. Free of the VS Code API.
import type { WizardUi } from '../connections/ports';
import type { TableRef } from '../data/types';
import { AantjeError, isAantjeError, isAborted } from '../errors';
import { describeTarget } from './copy';
import type { CopySource } from './flow';
import type { IcebergCheck } from './read';
import type { IcebergCopies, IcebergCopyRecord } from './records';
import type { LakeFacts } from './status';
import type { SyncRequest, SyncResult } from './sync';
import { modeCounts, planSync } from './sync-plan';
import type { SyncStep } from './sync-plan';
import type { IcebergTarget } from './target';

export interface SyncFlowDeps {
  readonly copies: Pick<IcebergCopies, 'list' | 'save'> & Partial<Pick<IcebergCopies, 'rememberFailures'>>;
  /** A fresh check of the copy of the target: the state of each table and the tables new in the lake. */
  readonly check: (targetId: string) => Promise<IcebergCheck | undefined>;
  /** The lake's tables and changes since the oldest of the records. */
  readonly lakeFacts: (records: readonly IcebergCopyRecord[]) => Promise<LakeFacts>;
  /** The `PARTITIONED BY` lists of the tables that are written new, by `schema.table`. */
  readonly partitions: (tables: readonly TableRef[]) => Promise<ReadonlyMap<string, string>>;
  /** The ids of the tables of the lake at a snapshot, by `schema.table`. */
  readonly tableIds?: (snapshot: number) => Promise<ReadonlyMap<string, number>>;
  /** Runs the sync under a notification with Cancel. */
  readonly sync: (request: Omit<SyncRequest, 'access' | 'report'>, title: string) => Promise<SyncResult>;
  readonly now?: () => Date;
}

/** The records of a target that a source covers: all for the lake, those of a schema, the one of a table. */
export function coveredRecords(
  records: readonly IcebergCopyRecord[],
  targetId: string,
  source: CopySource,
): IcebergCopyRecord[] {
  return records.filter(
    (record) =>
      record.targetId === targetId &&
      (source.kind === 'lake' ||
        (record.schema === source.schema && (source.kind === 'schema' || record.table === source.table))),
  );
}

/** A step for a table that the lake has and no sync wrote yet: it is written new, as the sync covers it. */
function newTableStep(
  connectionId: string,
  targetId: string,
  table: TableRef,
  scope: IcebergCopyRecord['scope'],
): SyncStep {
  return {
    record: {
      connectionId,
      targetId,
      schema: table.schema,
      table: table.table,
      snapshot: 0,
      copiedAt: '',
      ...(scope === undefined ? {} : { scope }),
    },
    lake: table,
    mode: 'create',
    overwrites: false,
    unchecked: false,
  };
}

/** What the sync will do, in words for the question. */
export function syncPlanText(steps: readonly SyncStep[]): string {
  const counts = modeCounts(steps);
  const parts = [
    counts.append > 0 ? `${counts.append} appended` : '',
    counts.replace > 0 ? `${counts.replace} replaced` : '',
    counts.recreate > 0 ? `${counts.recreate} written new because the lake altered them` : '',
    counts.create > 0 ? `${counts.create} written new because Iceberg lacks them` : '',
    counts.none > 0 ? `${counts.none} unchanged` : '',
    counts.skip > 0 ? `${counts.skip} dropped in the lake and left alone` : '',
  ].filter((part) => part !== '');
  const overwritten = steps.filter((step) => step.overwrites && step.mode !== 'none' && step.mode !== 'skip');
  const unchecked = steps.filter((step) => step.unchecked && step.mode !== 'skip');
  return [
    `Tables: ${parts.join(', ')}.`,
    ...(overwritten.length === 0
      ? []
      : [
          `${overwritten.map((step) => `${step.record.schema}.${step.record.table}`).join(', ')} ${overwritten.length === 1 ? 'was' : 'were'} changed in Iceberg after the last sync; those changes are lost.`,
        ]),
    ...(unchecked.length === 0
      ? []
      : ['The Iceberg catalog could not be checked, so the plan rests on the lake alone.']),
    ...(counts.recreate > 0 ? ['A table written new starts a new snapshot history in Iceberg.'] : []),
  ].join(' ');
}

/** What a sync of tables synced before came to: written, nothing to write, or not wanted. */
export type SyncOutcome =
  | { readonly kind: 'synced'; readonly result: SyncResult }
  | { readonly kind: 'nothing'; readonly snapshot: number }
  | { readonly kind: 'declined' };

/**
 * Brings the tables that the source covers in the target to the state of the lake at the snapshot (the newest one, or
 * the one pinned in the explorer), after a question that says what will happen. New tables of a synced lake or schema
 * are written too.
 */
export async function syncIcebergFlow(
  ui: WizardUi,
  deps: SyncFlowDeps,
  lake: { readonly id: string; readonly name: string },
  target: IcebergTarget,
  secret: string | undefined,
  snapshot: number | undefined,
  source: CopySource,
): Promise<SyncOutcome> {
  const records = coveredRecords(deps.copies.list(lake.id), target.id, source);
  const check = await deps.check(target.id);
  const facts = await deps.lakeFacts(records);
  const upTo = snapshot ?? facts.newest;
  const covers = records.some((record) => (record.scope ?? 'lake') === 'lake')
    ? () => true
    : (table: TableRef) =>
        records.some((record) => record.scope === 'schema' && record.schema === table.schema);
  const added = (check?.status.added ?? [])
    .filter((table) => (source.kind === 'lake' || table.schema === source.schema) && covers(table))
    .filter(() => source.kind !== 'table');
  const scopeOfNew = records.some((record) => (record.scope ?? 'lake') === 'lake') ? 'lake' : 'schema';
  const steps = [
    ...planSync(records, facts, check?.status.tables ?? [], upTo),
    ...added.map((table) => newTableStep(lake.id, target.id, table, scopeOfNew)),
  ];
  const writing = steps.filter((step) => step.mode !== 'none' && step.mode !== 'skip');
  const at = snapshot === undefined ? `the newest snapshot (${upTo})` : `snapshot ${snapshot}`;
  if (writing.length === 0) {
    ui.info(
      `The Iceberg tables in ${target.name} have the state of "${lake.name}" at ${at}: nothing to sync.`,
    );
    return { kind: 'nothing', snapshot: upTo };
  }
  const confirmed = await ui.confirm(
    `Sync ${steps.length} ${steps.length === 1 ? 'table' : 'tables'} of "${lake.name}" to ${describeTarget(target)} at ${at}? ${syncPlanText(steps)}`,
    'Sync',
  );
  if (!confirmed) return { kind: 'declined' };

  let result: SyncResult;
  try {
    const partitions = await deps.partitions(
      writing
        .filter((step) => step.mode === 'recreate' || step.mode === 'create')
        .flatMap((step) => step.lake ?? []),
    );
    result = await deps.sync(
      { target, secret, steps: writing, partitions },
      `Syncing "${lake.name}" to ${target.name}...`,
    );
  } catch (error) {
    if (isAborted(error) || !isAantjeError(error)) throw error;
    throw new AantjeError(error.code, `Sync to Iceberg failed: ${error.userMessage}`, { cause: error });
  }
  await remember(
    deps,
    result,
    steps.filter((step) => step.mode === 'none'),
  );
  // The tables it could not write: the report shows them as errors until a later sync writes them.
  await deps.copies.rememberFailures?.(lake.id, target.id, {
    failed: result.tables
      .filter((table) => table.status === 'failed')
      .map(({ step, error }) => ({
        schema: step.lake?.schema ?? step.record.schema,
        table: step.lake?.table ?? step.record.table,
        error: error ?? 'failed',
        snapshot: result.snapshot,
        failedAt: (deps.now?.() ?? new Date()).toISOString(),
      })),
    written: result.tables
      .filter((table) => table.status === 'synced')
      .map(({ step }) => ({
        schema: step.lake?.schema ?? step.record.schema,
        table: step.lake?.table ?? step.record.table,
      })),
  });
  const synced = result.tables.filter((table) => table.status === 'synced');
  const failed = result.tables.filter((table) => table.status === 'failed');
  const summary = `Synced ${synced.length} of ${writing.length} ${writing.length === 1 ? 'table' : 'tables'} of "${lake.name}" to ${target.name} at snapshot ${result.snapshot}.`;
  if (failed.length === 0) ui.info(summary);
  else
    ui.error(
      `${summary} Failed: ${failed
        .slice(0, 3)
        .map((table) => `${table.step.record.schema}.${table.step.record.table}: ${table.error ?? 'failed'}`)
        .join('; ')}${failed.length > 3 ? `; and ${failed.length - 3} more` : ''}.`,
    );
  return { kind: 'synced', result };
}

/** Moves the records of the synced tables, and of those the lake did not change, to the snapshot of the sync. */
async function remember(
  deps: SyncFlowDeps,
  result: SyncResult,
  unchanged: readonly SyncStep[],
): Promise<void> {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const ids = await deps.tableIds?.(result.snapshot).catch(() => undefined);
  const moved = (step: SyncStep): Pick<IcebergCopyRecord, 'snapshot' | 'snapshotTime'> => ({
    snapshot: result.snapshot,
    ...(result.snapshotTime === undefined ? {} : { snapshotTime: result.snapshotTime }),
    ...(step.lake === undefined ? {} : {}),
  });
  const records: IcebergCopyRecord[] = [
    ...result.tables
      .filter((table) => table.status === 'synced')
      .map((table): IcebergCopyRecord => {
        const { record, lake } = table.step;
        const tableId =
          ids?.get(`${lake?.schema ?? record.schema}.${lake?.table ?? record.table}`) ?? record.tableId;
        const rows =
          table.step.mode === 'append' && record.rows !== undefined && table.rows !== undefined
            ? record.rows + table.rows
            : table.rows;
        return {
          ...record,
          ...moved(table.step),
          ...(tableId === undefined ? {} : { tableId }),
          ...(table.icebergSnapshot === undefined ? {} : { icebergSnapshot: table.icebergSnapshot }),
          ...(rows === undefined ? {} : { rows }),
          ...(table.converted === undefined ? {} : { converted: table.converted }),
          copiedAt: at,
        };
      }),
    ...unchanged.map((step) => ({ ...step.record, ...moved(step) })),
  ];
  await deps.copies.save(records);
}
