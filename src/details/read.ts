import { isMaintenanceAction } from '../catalog/changes';
import type { ResolvedChange } from '../catalog/model';
import { queryCancelled } from '../catalog/drivers/limits';
import type {
  CatalogReader,
  MaintenanceFacts,
  PartitioningInfo,
  SchemaInfo,
  SnapshotActivityPage,
  SnapshotId,
  SortOrderInfo,
  TableInfo,
} from '../catalog/model';
import { ACTIVITY_LIMIT, SMALL_FILE_BYTES } from '../catalog/thresholds';
import { macroNodeKind } from '../dependencies/graph';
import type { DependencyGraph } from '../dependencies/graph';
import { overloadText } from '../macro-call';
import { collator } from '../order';
import type { ReportScope } from '../shell/scope';
import { OBJECT_LIMIT } from './model';
import type { DetailsData, DetailsMacro, DetailsObject, SnapshotMark } from './model';

/** What the report reads: the objects, the figures of the Statistics and Storage reports, the changes, the layout. */
export type DetailsReader = Pick<
  CatalogReader,
  | 'schemas'
  | 'tables'
  | 'views'
  | 'macros'
  | 'smallFiles'
  | 'deleteFiles'
  | 'maintenanceFacts'
  | 'partitioning'
  | 'sortOrder'
  | 'snapshotActivity'
>;

export interface DetailsInputs {
  readonly connection: string;
  /** The snapshot that the tree shows. */
  readonly snapshot: SnapshotId;
  readonly scope: ReportScope;
  /** The tree shows the newest snapshot: DuckLake counts inlined rows there only. */
  readonly latest: boolean;
  readonly now: Date;
  /** The dependencies at the snapshot (the Dependencies report's read); a failure leaves the counts out. */
  readonly graph: (signal: AbortSignal | undefined) => Promise<DependencyGraph>;
}

// Schemas whose tables are read at the same time, and tables whose partitioning and sort order are.
const SCHEMAS_AT_ONCE = 4;
const LAYOUTS_AT_ONCE = 8;

const stopped = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw queryCancelled();
};

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  signal: AbortSignal | undefined,
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    stopped(signal);
    results.push(...(await Promise.all(items.slice(start, start + size).map(read))));
  }
  return results;
}

/** `kind, month(ts)`; null without a partitioning or for one that was reset. */
export function partitioningText(partitioning: PartitioningInfo | undefined): string | null {
  const columns = partitioning?.columns ?? [];
  if (columns.length === 0) return null;
  return columns
    .map(({ path, transform }) =>
      transform === 'identity' ? path.join('.') : `${transform}(${path.join('.')})`,
    )
    .join(', ');
}

/** `sensor ASC, taken_at DESC`; null without a sort order. */
export const sortOrderText = (sortOrder: SortOrderInfo | undefined): string | null =>
  sortOrder === undefined || sortOrder.expressions.length === 0
    ? null
    : sortOrder.expressions.map(({ expression, direction }) => `${expression} ${direction}`).join(', ');

const objectKeyOf = (change: ResolvedChange): string | undefined => {
  if (change.objectId === null || isMaintenanceAction(change.action)) return undefined;
  switch (change.object) {
    case 'table':
    case 'view':
      return `${change.object}:${change.objectId}`;
    case 'scalar_macro':
      return `scalarMacro:${change.objectId}`;
    case 'table_macro':
      return `tableMacro:${change.objectId}`;
    default:
      return undefined;
  }
};

/** The newest snapshot of the page that changed each object (maintenance of its files aside), and the one that created it. */
function changeMarks(
  page: SnapshotActivityPage,
): Map<string, { last: SnapshotMark; created?: SnapshotMark }> {
  const marks = new Map<string, { last: SnapshotMark; created?: SnapshotMark }>();
  // Newest first: the first change of an object is its last, the last creation its first.
  for (const { id, time, changes } of page.snapshots) {
    const mark = { snapshot: id, time };
    for (const change of changes) {
      const key = objectKeyOf(change);
      if (key === undefined) continue;
      const known = marks.get(key) ?? { last: mark };
      marks.set(key, change.action === 'created' ? { ...known, created: mark } : known);
    }
  }
  return marks;
}

/** How many objects each object uses and is used by, by graph key. */
function dependencyCounts(
  graph: DependencyGraph | undefined,
): ((key: string) => [number, number]) | undefined {
  if (!graph) return undefined;
  const uses = new Map<number, Set<number>>();
  const users = new Map<number, Set<number>>();
  for (const { from, to } of graph.edges) {
    uses.set(from, (uses.get(from) ?? new Set()).add(to));
    users.set(to, (users.get(to) ?? new Set()).add(from));
  }
  const index = new Map(graph.nodes.map((node, at) => [`${node.kind}:${node.id}`, at]));
  return (key) => {
    const at = index.get(key);
    return at === undefined ? [0, 0] : [uses.get(at)?.size ?? 0, users.get(at)?.size ?? 0];
  };
}

function inlinedStatus(latest: boolean, facts: MaintenanceFacts | undefined): DetailsData['inlined'] {
  if (!latest) return 'older';
  if (!facts) return 'failed';
  return facts.inlinedFailed || facts.inlinedMore ? 'partial' : 'counted';
}

const bySchemaAndName =
  (schemas: ReadonlyMap<number, string>) =>
  (
    a: { readonly schemaId: number; readonly name: string },
    b: { readonly schemaId: number; readonly name: string },
  ): number =>
    collator.compare(schemas.get(a.schemaId) ?? '', schemas.get(b.schemaId) ?? '') ||
    collator.compare(a.name, b.name);

/**
 * The tables, views and macros of the lake or a schema at the snapshot that the tree shows, with the figures of the
 * Statistics and Storage reports, their partitioning and sort order, their last change and creation, and their
 * dependencies. Only the catalog is read; no data file is opened.
 */
export async function readDetails(
  reader: DetailsReader,
  inputs: DetailsInputs,
  signal?: AbortSignal,
): Promise<DetailsData> {
  const { snapshot, scope, latest } = inputs;
  const schemas: SchemaInfo[] = (await reader.schemas(snapshot)).filter(
    ({ id }) => scope.kind === 'lake' || id === scope.id,
  );
  const schemaId = scope.kind === 'schema' ? scope.id : null;
  const scopeRef = schemaId === null ? {} : { schemaId };
  const [tableLists, views, macros, small, deletes, facts, activity, graph] = await Promise.all([
    inBatches(schemas, SCHEMAS_AT_ONCE, signal, (schema) => reader.tables(schema.id, snapshot)),
    reader.views(schemaId, snapshot),
    reader.macros(schemaId, snapshot),
    reader.smallFiles(snapshot, signal),
    reader.deleteFiles(snapshot, scopeRef, signal),
    latest ? reader.maintenanceFacts(scopeRef, OBJECT_LIMIT, signal).catch(() => undefined) : undefined,
    reader.snapshotActivity(ACTIVITY_LIMIT, { to: snapshot }, signal),
    inputs.graph(signal).catch(() => undefined),
  ]);
  stopped(signal);
  const names = new Map(schemas.map(({ id, name }) => [id, name]));
  const order = bySchemaAndName(names);
  const inScope = <T extends { readonly schemaId: number }>(list: readonly T[]): T[] =>
    list.filter((item) => names.has(item.schemaId));
  const tables = tableLists.flat().toSorted(order);
  const shownViews = inScope(views).toSorted(order);
  const relations = [
    ...tables.map((table) => ({ kind: 'table' as const, table })),
    ...shownViews.map((view) => ({ kind: 'view' as const, view })),
  ]
    .toSorted((a, b) => order(a.kind === 'table' ? a.table : a.view, b.kind === 'table' ? b.table : b.view))
    .slice(0, OBJECT_LIMIT);

  const layoutTables = relations.flatMap((relation) => (relation.kind === 'table' ? [relation.table] : []));
  const layouts = new Map(
    await inBatches(layoutTables, LAYOUTS_AT_ONCE, signal, async (table: TableInfo) => {
      const [partitioning, sortOrder] = await Promise.all([
        reader.partitioning(table.id, snapshot),
        reader.sortOrder(table.id, snapshot),
      ]);
      return [
        table.id,
        { partitioning: partitioningText(partitioning), sortOrder: sortOrderText(sortOrder) },
      ] as const;
    }),
  );

  const marks = changeMarks(activity);
  const dependencies = dependencyCounts(graph);
  const smallOf = new Map(small.map(({ tableId, small: files }) => [tableId, files]));
  const inlined = new Map((facts?.inlined ?? []).map(({ tableId, rows }) => [tableId, rows]));
  const status = inlinedStatus(latest, facts);
  const common = (
    key: string,
    item: { readonly id: number; readonly schemaId: number; readonly name: string },
  ) => {
    const [dependsOn, usedBy] = dependencies?.(key) ?? [null, null];
    const mark = marks.get(key);
    return {
      id: item.id,
      schemaId: item.schemaId,
      schema: names.get(item.schemaId) ?? '',
      name: item.name,
      lastChange: mark?.last ?? null,
      created: mark?.created ?? null,
      dependsOn,
      usedBy,
    };
  };

  const objects: DetailsObject[] = relations.map((relation) => {
    if (relation.kind === 'view') {
      const { view } = relation;
      return { ...common(`view:${view.id}`, view), kind: 'view', comment: view.comment };
    }
    const { table } = relation;
    const layout = layouts.get(table.id);
    return {
      ...common(`table:${table.id}`, table),
      kind: 'table',
      comment: table.comment,
      rows: table.stats.rows,
      ...(table.stats.approximate ? { approximate: true as const } : {}),
      sizeBytes: table.stats.sizeBytes,
      files: table.stats.files,
      smallFiles: smallOf.get(table.id) ?? 0,
      deleteFiles: deletes.get(table.id) ?? 0,
      inlinedRows: status === 'older' || status === 'failed' ? null : (inlined.get(table.id) ?? 0),
      partitioning: layout?.partitioning ?? null,
      sortOrder: layout?.sortOrder ?? null,
    };
  });
  const detailsMacros: DetailsMacro[] = inScope(macros)
    .toSorted(order)
    .map((macro) => ({
      ...common(`${macroNodeKind(macro)}:${macro.id}`, macro),
      kind: macro.kind,
      overloads: macro.implementations.length,
      parameters: overloadText(macro.implementations[0]?.parameters ?? []),
    }));

  return {
    connection: inputs.connection,
    scope,
    snapshot,
    readAt: inputs.now.toISOString(),
    objects,
    objectCount: tables.length + shownViews.length,
    macros: detailsMacros,
    smallFileBytes: SMALL_FILE_BYTES,
    changesFrom: activity.more ? (activity.snapshots.at(-1)?.id ?? snapshot) : null,
    inlined: status,
    dependencies: graph !== undefined,
  };
}
