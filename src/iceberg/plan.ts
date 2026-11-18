// What a sync to Iceberg will do with the tables of its scope, read from the catalog before anything is written.
import type { CatalogReader } from '../catalog/model';
import { inScope } from './copy';
import type { CopyScope } from './copy';
import { partitionedBy, tablePlan } from './mapping';
import type { TablePlan } from './mapping';

export interface CopyPlan {
  readonly tables: readonly TablePlan[];
  /** The `PARTITIONED BY` list of each table that Iceberg can partition like the lake, by `schema.table`. */
  readonly partitions: ReadonlyMap<string, string>;
}

/** The plan of the tables of the scope at the snapshot, from the explorer's reader; `extra` are the casts of the target. */
export async function readCopyPlan(
  reader: Pick<CatalogReader, 'entries' | 'columnEntries' | 'partitioning'>,
  snapshot: number,
  scope: CopyScope,
  extra: Readonly<Record<string, string>> = {},
): Promise<CopyPlan> {
  const tables = (await reader.entries(snapshot)).filter(
    (entry) => entry.kind === 'table' && inScope(scope, { schema: entry.schemaName, table: entry.name }),
  );
  const columns = await reader.columnEntries(snapshot);
  const partitions = new Map<string, string>();
  for (const entry of tables) {
    const list = partitionedBy(await reader.partitioning(entry.id, snapshot));
    if (list !== undefined) partitions.set(`${entry.schemaName}.${entry.name}`, list);
  }
  return {
    tables: tables.map((entry) =>
      tablePlan({ schema: entry.schemaName, table: entry.name }, columns.get(entry.id) ?? [], extra),
    ),
    partitions,
  };
}

/** The `PARTITIONED BY` list of each of the tables that Iceberg can partition like the lake, by `schema.table`. */
export async function readPartitions(
  reader: Pick<CatalogReader, 'entries' | 'partitioning'>,
  snapshot: number,
  tables: readonly { readonly schema: string; readonly table: string }[],
): Promise<ReadonlyMap<string, string>> {
  const wanted = new Set(tables.map(({ schema, table }) => `${schema}.${table}`));
  const partitions = new Map<string, string>();
  if (wanted.size === 0) return partitions;
  for (const entry of await reader.entries(snapshot)) {
    const key = `${entry.schemaName}.${entry.name}`;
    if (entry.kind !== 'table' || !wanted.has(key)) continue;
    const list = partitionedBy(await reader.partitioning(entry.id, snapshot));
    if (list !== undefined) partitions.set(key, list);
  }
  return partitions;
}
