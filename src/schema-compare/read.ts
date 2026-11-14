import type { CatalogReader, SchemaInfo, SnapshotId, TableInfo } from '../catalog/model';
import { inGroups, readCreatedTable, readTable } from '../ddl-script/read';
import type { CreatedTable } from '../ddl-script/table-ddl';
import type { TableState } from '../ddl-script/table-state';
import type { DependencyGraph } from '../dependencies/graph';
import { pairTables } from './schemas';
import type { Paired, SchemaComparison, SchemaObjects } from './schemas';
import type { SchemaScriptInput } from './update-schema';

// What Schema Compare reads, all from the catalog through the reader: no DuckDB engine and no data files.

async function readObjects(
  reader: Pick<CatalogReader, 'schemas' | 'tables' | 'views' | 'macros'>,
  snapshot: SnapshotId,
  schema: SchemaInfo,
): Promise<SchemaObjects> {
  const [schemas, tables, views, macros] = await Promise.all([
    reader.schemas(snapshot),
    reader.tables(schema.id, snapshot),
    reader.views(schema.id, snapshot),
    reader.macros(schema.id, snapshot),
  ]);
  return { schema, schemas, tables, views, macros };
}

export interface ReadSide {
  readonly reader: CatalogReader;
  readonly snapshot: SnapshotId;
  readonly schema: SchemaInfo;
}

const named = (schema: SchemaInfo, { id, name, comment }: TableInfo) => ({
  id,
  schemaName: schema.name,
  name,
  comment,
});

/** The objects of both schemas, and in full the tables of both up to the limit (`pairTables`). */
export async function readSchemas(
  left: ReadSide,
  right: ReadSide,
  signal?: AbortSignal,
): Promise<{
  readonly left: SchemaObjects;
  readonly right: SchemaObjects;
  readonly compared: readonly Paired<TableState>[];
  readonly omitted: number;
}> {
  const [leftObjects, rightObjects] = await Promise.all([
    readObjects(left.reader, left.snapshot, left.schema),
    readObjects(right.reader, right.snapshot, right.schema),
  ]);
  const { pairs, omitted } = pairTables(leftObjects.tables, rightObjects.tables);
  const compared = await inGroups(
    pairs,
    async (pair) => {
      const [leftTable, rightTable] = await Promise.all([
        readTable(left.reader, left.snapshot, named(left.schema, pair.left)),
        readTable(right.reader, right.snapshot, named(right.schema, pair.right)),
      ]);
      return { left: leftTable, right: rightTable };
    },
    signal,
  );
  return { left: leftObjects, right: rightObjects, compared, omitted };
}

/** The tables that only the source has, in full and with their options, for their CREATE TABLE. */
async function readCreated(
  sourceSide: () => ReadSide,
  tables: readonly TableInfo[],
  signal: AbortSignal | undefined,
): Promise<Map<number, CreatedTable>> {
  if (tables.length === 0) return new Map();
  const source = sourceSide();
  const metadata = await source.reader.metadata();
  const created = await inGroups(
    tables,
    async (table) =>
      [
        table.id,
        await readCreatedTable(source.reader, source.snapshot, named(source.schema, table), metadata),
      ] as const,
    signal,
  );
  return new Map(created);
}

/**
 * What Script as Update of two schemas needs besides the comparison: the tables that only the source (left) has, and
 * the dependency graphs that order the views and macros it creates and drops. `source` is asked for only when the
 * source has such tables; the graphs come from the objects in hand. `graphOf` is undefined when it fails.
 */
export async function readScriptParts(
  source: () => ReadSide,
  objects: Paired<SchemaObjects>,
  comparison: SchemaComparison,
  graphOf: (objects: SchemaObjects) => Promise<DependencyGraph | undefined>,
  signal?: AbortSignal,
): Promise<Pick<SchemaScriptInput, 'created' | 'graphs'>> {
  const { tables, views, macros } = comparison;
  const creates =
    views.onlyLeft.length + views.different.length + macros.onlyLeft.length + macros.different.length;
  const drops = views.onlyRight.length + macros.onlyRight.length;
  return {
    created: await readCreated(source, tables.onlyLeft, signal),
    // One object needs no order.
    graphs: {
      source: creates > 1 ? await graphOf(objects.left) : undefined,
      target: drops > 1 ? await graphOf(objects.right) : undefined,
    },
  };
}
