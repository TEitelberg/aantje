// The large tables of the scope that have no partitioning: the Maintenance Advisor offers Suggest Partitioning... for
// each. Read from the catalog at the newest snapshot; nothing of the data is read.
import type { CatalogReader, SnapshotId } from '../catalog/model';
import type { ReportScope } from '../shell/scope';
import type { AdvisorTable } from './model';

/** A table at least this large without a partitioning is a case for Suggest Partitioning. */
export const LARGE_TABLE_BYTES = 1024 * 1024 * 1024;
/** The most such tables the advisor lists, the largest first. */
export const UNPARTITIONED_LIMIT = 20;

/** What the list says, on the page and in the document. */
export const UNPARTITIONED_NOTE =
  'Tables of 1 GB or more without a partitioning. A filter reads all their files; Suggest Partitioning... measures which columns the queries filter on and what a partitioning would give.';

/** A large table without a partitioning. */
export interface UnpartitionedTable {
  readonly table: AdvisorTable;
  readonly sizeBytes: number;
  readonly rows: number;
}

/** The large tables of the scope without a partitioning at the snapshot, the largest first. */
export async function largeUnpartitioned(
  reader: Pick<CatalogReader, 'schemas' | 'tables' | 'partitioning'>,
  scope: ReportScope,
  snapshot: SnapshotId,
  signal?: AbortSignal,
): Promise<UnpartitionedTable[]> {
  const schemas = (await reader.schemas(snapshot)).filter(
    ({ id }) => scope.kind === 'lake' || id === scope.id,
  );
  const large: UnpartitionedTable[] = [];
  for (const schema of schemas) {
    if (signal?.aborted) break;
    for (const table of await reader.tables(schema.id, snapshot)) {
      if (table.stats.sizeBytes >= LARGE_TABLE_BYTES) {
        large.push({
          table: { id: table.id, schemaId: schema.id, schema: schema.name, name: table.name },
          sizeBytes: table.stats.sizeBytes,
          rows: table.stats.rows,
        });
      }
    }
  }
  const found: UnpartitionedTable[] = [];
  for (const entry of large.toSorted((a, b) => b.sizeBytes - a.sizeBytes || a.table.id - b.table.id)) {
    if (found.length >= UNPARTITIONED_LIMIT || signal?.aborted) break;
    if (!(await reader.partitioning(entry.table.id, snapshot))) found.push(entry);
  }
  return found;
}
