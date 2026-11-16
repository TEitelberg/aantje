import { isObject } from '../guards';

/** The part of the VS Code `Memento` the records use. */
export interface RecordStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** What aantje remembers of one copy: from which DuckLake snapshot, and which Iceberg snapshot it wrote. */
export interface IcebergCopyRecord {
  readonly connectionId: string;
  readonly targetId: string;
  readonly schema: string;
  readonly table: string;
  /** The id of the table in the lake; it survives a rename. */
  readonly tableId?: number;
  readonly snapshot: number;
  readonly snapshotTime?: string;
  /** The Iceberg snapshot that the copy wrote, as text; undefined when it could not be read. */
  readonly icebergSnapshot?: string;
  /** The rows that the copy wrote. */
  readonly rows?: number;
  /** Columns that were written as another type, for example `id: UBIGINT as DECIMAL(20,0)`. */
  readonly converted?: readonly string[];
  readonly copiedAt: string;
  /** The Iceberg namespace and table, when not the schema and table of the lake (a table copied under another name). */
  readonly icebergNamespace?: string;
  readonly icebergTable?: string;
  /**
   * What the copy covered: the whole lake (also when not set), a schema or one table. A table of the lake that no
   * copy has counts as missing only where the copy covered it.
   */
  readonly scope?: 'lake' | 'schema' | 'table';
}

/** The Iceberg table of a record: `namespace.table`, the schema and table of the lake unless copied elsewhere. */
export const icebergKeyOf = (record: IcebergCopyRecord): string =>
  `${record.icebergNamespace ?? record.schema}.${record.icebergTable ?? record.table}`;

/** The Iceberg table of a record for the REST check: its namespace as `schema`. */
export const icebergRefOf = (record: IcebergCopyRecord): { schema: string; table: string } => ({
  schema: record.icebergNamespace ?? record.schema,
  table: record.icebergTable ?? record.table,
});

const KEY = 'aantje.icebergCopies';
const keyOf = (r: Pick<IcebergCopyRecord, 'connectionId' | 'targetId' | 'schema' | 'table'>): string =>
  JSON.stringify([r.connectionId, r.targetId, r.schema, r.table]);

/** The copies to Iceberg that aantje made, in its own state; the base of "newer snapshot available" and of Sync. */
export class IcebergCopies {
  constructor(private readonly state: RecordStore) {}

  list(connectionId?: string): IcebergCopyRecord[] {
    return Object.values(this.all())
      .filter(isRecord)
      .filter((r) => connectionId === undefined || r.connectionId === connectionId);
  }

  /** A copy of the whole lake to a target: its records replace all earlier ones of the connection and the target. */
  async replaceAll(
    connectionId: string,
    targetId: string,
    records: readonly IcebergCopyRecord[],
  ): Promise<void> {
    await this.forget({ connectionId, targetId });
    await this.save(records);
  }

  /** A copy of a schema: its records replace the earlier ones of the schema in the connection and target. */
  async replaceSchema(
    connectionId: string,
    targetId: string,
    schema: string,
    records: readonly IcebergCopyRecord[],
  ): Promise<void> {
    const kept = Object.fromEntries(
      Object.entries(this.all()).filter(
        ([, value]) =>
          !isRecord(value) ||
          value.connectionId !== connectionId ||
          value.targetId !== targetId ||
          value.schema !== schema,
      ),
    );
    for (const record of records) kept[keyOf(record)] = record;
    await this.state.update(KEY, kept);
  }

  /** Replaces the records of the same connection, target and table; the others stay. */
  async save(records: readonly IcebergCopyRecord[]): Promise<void> {
    const all = this.all();
    for (const record of records) all[keyOf(record)] = record;
    await this.state.update(KEY, all);
  }

  /** A removed connection or target takes its records with it. */
  async forget(match: { connectionId?: string; targetId?: string }): Promise<void> {
    const kept = Object.fromEntries(
      Object.entries(this.all()).filter(([, value]) => {
        if (!isRecord(value)) return true;
        return !(
          (match.connectionId === undefined || value.connectionId === match.connectionId) &&
          (match.targetId === undefined || value.targetId === match.targetId)
        );
      }),
    );
    await this.state.update(KEY, kept);
  }

  private all(): Record<string, unknown> {
    const value = this.state.get(KEY);
    return isObject(value) ? { ...value } : {};
  }
}

function isRecord(value: unknown): value is IcebergCopyRecord {
  return (
    isObject(value) &&
    typeof value.connectionId === 'string' &&
    typeof value.targetId === 'string' &&
    typeof value.schema === 'string' &&
    typeof value.table === 'string' &&
    typeof value.snapshot === 'number' &&
    (value.tableId === undefined || typeof value.tableId === 'number') &&
    typeof value.copiedAt === 'string' &&
    (value.icebergNamespace === undefined || typeof value.icebergNamespace === 'string') &&
    (value.icebergTable === undefined || typeof value.icebergTable === 'string') &&
    (value.scope === undefined ||
      value.scope === 'lake' ||
      value.scope === 'schema' ||
      value.scope === 'table')
  );
}
