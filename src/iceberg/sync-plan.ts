// What a sync to Iceberg does with each table that was synced before, decided from the lake's changes since then and
// from what the last check of the Iceberg catalog said. Pure: the flow shows the plan, the engine carries it out.
import type { TableRef } from '../data/types';
import type { IcebergCopyRecord } from './records';
import type { LakeFacts, TableStatus } from './status';

/**
 * - `none`: the lake did not change the table's rows or columns (a rename at most): nothing is written.
 * - `append`: the lake only inserted rows: they are appended.
 * - `replace`: the lake deleted or updated rows, or Iceberg holds what the lake does not: the rows are replaced.
 * - `recreate`: the lake altered the table (its columns may differ): the Iceberg table is dropped and written new.
 * - `create`: the Iceberg table is missing: it is written new.
 * - `skip`: the table was dropped in the lake: nothing to sync.
 */
export type SyncMode = 'none' | 'append' | 'replace' | 'recreate' | 'create' | 'skip';

export interface SyncStep {
  readonly record: IcebergCopyRecord;
  /** The table in the lake as it is named now (a rename keeps its id); undefined for a table dropped in the lake. */
  readonly lake: TableRef | undefined;
  readonly mode: SyncMode;
  /** True when Iceberg was changed after the last sync: writing loses those changes. */
  readonly overwrites: boolean;
  /** True when the Iceberg side could not be checked: the plan rests on the lake alone. */
  readonly unchecked: boolean;
}

/** The plan of every record, at the snapshot `upTo` (the newest or the pinned one). */
export function planSync(
  records: readonly IcebergCopyRecord[],
  lake: LakeFacts,
  statuses: readonly TableStatus[],
  upTo: number,
): SyncStep[] {
  const byName = new Map([...lake.tables].map(([id, { schema, name }]) => [`${schema}.${name}`, id]));
  return records.map((record) => {
    const status = statuses.find((entry) => entry.schema === record.schema && entry.table === record.table);
    const problems = new Set(status?.problems ?? []);
    const id =
      record.tableId !== undefined
        ? lake.tables.has(record.tableId)
          ? record.tableId
          : undefined
        : byName.get(`${record.schema}.${record.table}`);
    const found = id === undefined ? undefined : lake.tables.get(id);
    const overwrites = problems.has('iceberg-ahead') || problems.has('iceberg-replaced');
    const unchecked = status === undefined || problems.has('not-checked');
    if (id === undefined || found === undefined) {
      return { record, lake: undefined, mode: 'skip', overwrites: false, unchecked };
    }
    const actions = new Set(
      lake
        .changes(id, record.snapshot)
        .filter((change) => change.snapshot <= upTo)
        .flatMap((change) => [...change.actions]),
    );
    const step = (mode: SyncMode): SyncStep => ({
      record,
      lake: { schema: found.schema, table: found.name },
      mode,
      overwrites,
      unchecked,
    });
    if (problems.has('iceberg-missing')) return step('create');
    if (actions.has('altered') || actions.has('created')) return step('recreate');
    if (actions.has('deleted') || actions.has('inlined_delete') || overwrites) return step('replace');
    if (actions.has('inserted') || actions.has('inlined_insert')) return step('append');
    return step('none');
  });
}

/** How many steps of each mode, for the question before the sync and the message after it. */
export function modeCounts(steps: readonly SyncStep[]): Readonly<Record<SyncMode, number>> {
  const counts: Record<SyncMode, number> = {
    none: 0,
    append: 0,
    replace: 0,
    recreate: 0,
    create: 0,
    skip: 0,
  };
  for (const step of steps) counts[step.mode] += 1;
  return counts;
}
