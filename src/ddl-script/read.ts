import { queryCancelled } from '../catalog/drivers/limits';
import type { CatalogEntry, CatalogReader, MetadataEntry, SnapshotId } from '../catalog/model';
import { tableOptionsOf } from '../maintenance/options';
import type { CreatedTable } from './table-ddl';
import type { TableState } from './table-state';

// What the scripts read of a table, all from the catalog through the reader: no DuckDB engine and no data files.

type TableReads = Pick<CatalogReader, 'columns' | 'partitioning' | 'sortOrder'>;

/** What names a table: its id, its schema and name, and its comment. */
export type TableHead = Pick<TableState, 'id' | 'schemaName' | 'name' | 'comment'>;

/** Columns, partitioning and sort order of a table at a snapshot. */
export async function readTable(
  reader: TableReads,
  snapshot: SnapshotId,
  table: TableHead,
): Promise<TableState> {
  const read = reader.columns(table.id, snapshot);
  const [columns, partitioning, sortOrder] = await Promise.all([
    read,
    read.then((tree) => reader.partitioning(table.id, snapshot, tree)),
    reader.sortOrder(table.id, snapshot),
  ]);
  return { ...table, columns, partitioning, sortOrder };
}

/** A table that the picker offered, with the comment that the tables of its schema carry. */
export async function readPickedTable(
  reader: TableReads & Pick<CatalogReader, 'tables'>,
  snapshot: SnapshotId,
  entry: CatalogEntry,
): Promise<TableState> {
  const tables = await reader.tables(entry.schemaId, snapshot);
  const comment = tables.find(({ id }) => id === entry.id)?.comment ?? null;
  return readTable(reader, snapshot, {
    id: entry.id,
    schemaName: entry.schemaName,
    name: entry.name,
    comment,
  });
}

/**
 * A table in full for its CREATE TABLE, with the options that the metadata of the catalog gives it. A caller that
 * creates several tables reads the metadata once and hands it over, or the pending read.
 */
export async function readCreatedTable(
  reader: TableReads,
  snapshot: SnapshotId,
  table: TableHead,
  metadata: readonly MetadataEntry[] | Promise<readonly MetadataEntry[]>,
): Promise<CreatedTable> {
  const [state, entries] = await Promise.all([readTable(reader, snapshot, table), metadata]);
  return { state, options: tableOptionsOf(entries, table.id, state.columns) };
}

// Tables read at the same time; a remote catalog answers each read with a round trip.
const READ_AT_ONCE = 4;

/** Runs `read` for the items, `READ_AT_ONCE` at a time; the signal stops it between the groups. */
export async function inGroups<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
  signal: AbortSignal | undefined,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += READ_AT_ONCE) {
    if (signal?.aborted) throw queryCancelled();
    results.push(...(await Promise.all(items.slice(start, start + READ_AT_ONCE).map(read))));
  }
  return results;
}
