import type { CatalogReader, SnapshotId } from '../catalog/model';
import { inGroups, readCreatedTable } from '../ddl-script/read';
import type { CreatedTable } from '../ddl-script/table-ddl';
import type { CatalogObjects, DependencyGraph } from '../dependencies/graph';
import type { LakeObject } from './objects';

// What Generate Scripts reads besides the objects of the picker, all from the catalog through the reader: no DuckDB
// engine and no data files.

/** What the script is made of. */
export interface ScriptInput {
  readonly snapshot: SnapshotId;
  /** The selected objects. */
  readonly objects: readonly LakeObject[];
  /** The selected tables in full, with their options, by id. */
  readonly tables: ReadonlyMap<number, CreatedTable>;
  /** Which views and macros use which; undefined when there are none or the graph could not be read. */
  readonly graph: DependencyGraph | undefined;
}

type Reads = Pick<CatalogReader, 'columns' | 'partitioning' | 'sortOrder' | 'tables' | 'metadata'>;

/** The selected tables in full: columns, partitioning, sort order, comment and options. */
async function readTables(
  reader: Reads,
  snapshot: SnapshotId,
  objects: readonly LakeObject[],
  signal: AbortSignal | undefined,
): Promise<Map<number, CreatedTable>> {
  const tables = objects.filter((object) => object.kind === 'table');
  if (tables.length === 0) return new Map();
  // The comment of a table comes with the tables of its schema: one read per schema.
  const schemaIds = [...new Set(tables.map(({ schema }) => schema.id))];
  const [metadata, ...perSchema] = await Promise.all([
    reader.metadata(),
    ...schemaIds.map((id) => reader.tables(id, snapshot)),
  ]);
  const comments = new Map(perSchema.flat().map(({ id, comment }) => [id, comment]));
  const read = await inGroups(
    tables,
    async ({ id, name, schema }) => {
      const head = { id, schemaName: schema.name, name, comment: comments.get(id) ?? null };
      return [id, await readCreatedTable(reader, snapshot, head, metadata)] as const;
    },
    signal,
  );
  return new Map(read);
}

/**
 * The input of the script for the selected objects. `graphOf` builds the dependency graph from every object of the
 * lake, so that a view can name an object of another schema; it is asked only when views or macros are selected.
 */
export async function readScriptInput(
  reader: Reads,
  snapshot: SnapshotId,
  lake: CatalogObjects,
  objects: readonly LakeObject[],
  graphOf: (lake: CatalogObjects) => Promise<DependencyGraph | undefined>,
  signal?: AbortSignal,
): Promise<ScriptInput> {
  const tables = await readTables(reader, snapshot, objects, signal);
  const definitions = objects.some(({ kind }) => kind !== 'table');
  return { snapshot, objects, tables, graph: definitions ? await graphOf(lake) : undefined };
}
