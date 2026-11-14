import { foldIdentifier, sameIdentifier } from '../catalog/ddl';
import type {
  CatalogReader,
  ColumnInfo,
  MacroInfo,
  PartitioningInfo,
  SchemaInfo,
  SnapshotId,
  SnapshotInfo,
  SortOrderInfo,
  TableInfo,
  ViewInfo,
} from '../catalog/model';
import type { RelationColumn } from '../data/types';

export type SqlEntry =
  | { readonly kind: 'table'; readonly schema: SchemaInfo; readonly table: TableInfo }
  | { readonly kind: 'view'; readonly schema: SchemaInfo; readonly view: ViewInfo };

/** The schema that unqualified names belong to once the lake is the current catalog. */
export const DEFAULT_SCHEMA = 'main';

/** What the language service knows about the lake at one snapshot; `catalogOfReader` builds one from an explorer reader. */
export interface SqlCatalog {
  /** The attached name of the lake, as in `lake.sales.orders`. */
  readonly lake: string;
  schemas(): Promise<readonly SchemaInfo[]>;
  entries(): Promise<readonly SqlEntry[]>;
  /**
   * Columns in table order, nested fields in `children`. DuckLake stores no columns of a view: they come from binding
   * it in the background once the connection's views are trusted (`ViewColumnSource`), and are empty until then.
   */
  columns(schema: string, table: string): Promise<readonly ColumnInfo[]>;
  /**
   * The read of a view's columns that `columns` started and that has not ended; it settles when the read ends, also
   * when it fails. Undefined for a table, an unknown name and a view whose columns are read or not read at all.
   */
  columnsPending(schema: string, table: string): Promise<void> | undefined;
  /** Whether the columns of views are read: false while the user has not trusted the connection's views. */
  viewsTrusted(): boolean;
  macros(schema: string): Promise<readonly MacroInfo[]>;
  /** Newest first. */
  snapshots(): Promise<readonly SnapshotInfo[]>;
  /** How the files of a table are partitioned and sorted; nothing for a view or an unknown name. */
  layout(schema: string, table: string): Promise<TableLayout>;
  /** The same lake at another snapshot. */
  at(snapshot: SnapshotId): SqlCatalog;
}

export interface TableLayout {
  readonly partitioning: PartitioningInfo | undefined;
  readonly sortOrder: SortOrderInfo | undefined;
}

const NO_LAYOUT: TableLayout = { partitioning: undefined, sortOrder: undefined };

/** How a catalog learns the columns of a view: DuckDB binds the view, which runs the SQL stored in the catalog. */
export interface ViewColumnSource {
  /** Whether the user trusted the connection's views; asked at every request, never asking the user. */
  trusted(): boolean;
  /** The columns as DuckDB binds the view at the snapshot. */
  read(schema: SchemaInfo, view: ViewInfo, snapshot: SnapshotId): Promise<readonly RelationColumn[]>;
  /** A read failed: the view offers no columns at that snapshot. */
  failed(schema: SchemaInfo, view: ViewInfo, error: unknown): void;
}

const UNTRUSTED_VIEWS: ViewColumnSource = {
  trusted: () => false,
  read: () => Promise.resolve([]),
  failed: () => undefined,
};

// The catalogs of other snapshots that a reader's catalog keeps besides its own (`AT (VERSION => n)`).
const MAX_OTHER_SNAPSHOTS = 4;

/**
 * The catalog of a reader at one snapshot; each read runs once, a failed read is retried on the next call. A view is
 * bound once per snapshot, and only through `views`; without it, views offer no columns.
 */
export function catalogOfReader(
  reader: CatalogReader,
  snapshot: SnapshotId,
  lake = 'lake',
  views: ViewColumnSource = UNTRUSTED_VIEWS,
): SqlCatalog {
  const others = new Map<SnapshotId, SqlCatalog>();
  const at = (wanted: SnapshotId): SqlCatalog => {
    if (wanted === snapshot) return own;
    let found = others.get(wanted);
    if (!found) {
      found = snapshotCatalog(reader, wanted, { lake, views, at });
      others.set(wanted, found);
      const [oldest] = others.keys();
      if (others.size > MAX_OTHER_SNAPSHOTS && oldest !== undefined) others.delete(oldest);
    }
    return found;
  };
  const own = snapshotCatalog(reader, snapshot, { lake, views, at });
  return own;
}

const nameKey = (schema: string, name: string): string =>
  JSON.stringify([foldIdentifier(schema), foldIdentifier(name)]);

interface ViewColumns {
  columns(schema: SchemaInfo, view: ViewInfo): readonly ColumnInfo[];
  /** The read that `columns` started for the view of that name, while it runs. */
  pending(schema: string, view: string): Promise<void> | undefined;
}

// A request never waits for a view: the first one starts the read, a later one finds the columns.
function viewColumnsAt(views: ViewColumnSource, snapshot: SnapshotId): ViewColumns {
  const read = new Map<number, readonly ColumnInfo[] | undefined>();
  const running = new Map<string, Promise<void>>();
  return {
    columns: (schema, view) => {
      if (!views.trusted()) return [];
      if (!read.has(view.id)) {
        read.set(view.id, undefined);
        const name = nameKey(schema.name, view.name);
        running.set(
          name,
          views.read(schema, view, snapshot).then(
            (columns) => {
              read.set(view.id, columns.map(columnOfView));
              running.delete(name);
            },
            (error: unknown) => {
              read.set(view.id, []);
              running.delete(name);
              views.failed(schema, view, error);
            },
          ),
        );
      }
      return read.get(view.id) ?? [];
    },
    pending: (schema, view) => running.get(nameKey(schema, view)),
  };
}

function columnOfView({ name, type, nullable }: RelationColumn, index: number): ColumnInfo {
  return { id: index, name, type, nullable, defaultValue: null, comment: null, children: [] };
}

function snapshotCatalog(
  reader: CatalogReader,
  snapshot: SnapshotId,
  {
    lake,
    views: viewSource,
    at,
  }: { lake: string; views: ViewColumnSource; at: (snapshot: SnapshotId) => SqlCatalog },
): SqlCatalog {
  const cache = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    let promise = cache.get(key) as Promise<T> | undefined;
    if (!promise) {
      promise = read();
      cache.set(key, promise);
      // A failed read is not cached; the caller sees the failure through the returned promise.
      promise.catch(() => cache.delete(key));
    }
    return promise;
  };
  const schemas = (): Promise<SchemaInfo[]> => once('schemas', () => reader.schemas(snapshot));
  const entries = (): Promise<SqlEntry[]> =>
    once('entries', async () => {
      const lists = await Promise.all(
        (await schemas()).map(async (schema): Promise<SqlEntry[]> => {
          const [tables, views] = await Promise.all([
            reader.tables(schema.id, snapshot),
            reader.views(schema.id, snapshot),
          ]);
          return [
            ...tables.map((table): SqlEntry => ({ kind: 'table', schema, table })),
            ...views.map((view): SqlEntry => ({ kind: 'view', schema, view })),
          ];
        }),
      );
      return lists.flat();
    });
  const entryNamed = async (schema: string, name: string): Promise<SqlEntry | undefined> =>
    (await entries()).find((e) => sameIdentifier(e.schema.name, schema) && sameIdentifier(nameOf(e), name));
  const tableNamed = async (schema: string, table: string): Promise<TableInfo | undefined> => {
    const entry = await entryNamed(schema, table);
    return entry?.kind === 'table' ? entry.table : undefined;
  };
  const viewColumns = viewColumnsAt(viewSource, snapshot);
  const columns = async (schema: string, table: string): Promise<readonly ColumnInfo[]> => {
    const entry = await entryNamed(schema, table);
    if (entry?.kind === 'view') return viewColumns.columns(entry.schema, entry.view);
    return once(`columns:${nameKey(schema, table)}`, async () =>
      entry ? reader.columns(entry.table.id, snapshot) : [],
    );
  };
  return {
    lake,
    schemas,
    entries,
    columns,
    columnsPending: (schema, table) => viewColumns.pending(schema, table),
    viewsTrusted: () => viewSource.trusted(),
    macros: (schema) =>
      once(`macros:${schema}`, async () => {
        const found = (await schemas()).find((s) => sameIdentifier(s.name, schema));
        return found ? reader.macros(found.id, snapshot) : [];
      }),
    snapshots: () => once('snapshots', () => reader.snapshots()),
    layout: (schema, table) =>
      once(`layout:${nameKey(schema, table)}`, async (): Promise<TableLayout> => {
        const found = await tableNamed(schema, table);
        if (!found) return NO_LAYOUT;
        const [partitioning, sortOrder] = await Promise.all([
          reader.partitioning(found.id, snapshot, await columns(schema, table)),
          reader.sortOrder(found.id, snapshot),
        ]);
        return { partitioning, sortOrder };
      }),
    at,
  };
}

export function nameOf(entry: SqlEntry): string {
  return entry.kind === 'table' ? entry.table.name : entry.view.name;
}

/** A lake without objects: keywords, functions and types still complete without the real catalog. */
export const EMPTY_CATALOG: SqlCatalog = {
  lake: 'lake',
  schemas: () => Promise.resolve([]),
  entries: () => Promise.resolve([]),
  columns: () => Promise.resolve([]),
  columnsPending: () => undefined,
  viewsTrusted: () => false,
  macros: () => Promise.resolve([]),
  snapshots: () => Promise.resolve([]),
  layout: () => Promise.resolve(NO_LAYOUT),
  at: () => EMPTY_CATALOG,
};
