// What Rename... renames, the names it may not take, and the syncs to Iceberg of a renamed table. Free of the VS Code
// API.
import { foldIdentifier } from '../catalog/ddl';
import type { CatalogReader, SnapshotId } from '../catalog/model';
import type { IcebergCopies } from '../iceberg/records';
import type { IcebergTargetStore } from '../iceberg/store';
import type { NodeRef } from '../tree/refs';
import type { IcebergSync, Renamed } from './script';

/** A table, view or top-level column of a table, by the ids of the tree; `label` names it in the question. */
export type Wanted = {
  readonly id: number;
  readonly schemaId: number;
  readonly old: string;
  readonly label: string;
} & ({ readonly kind: 'table' | 'view' } | { readonly kind: 'column'; readonly column: string });

/** What a node renames; a text that says why not for a field of a struct; undefined for other nodes. */
export function whatToRename(ref: NodeRef): Wanted | string | undefined {
  switch (ref.kind) {
    case 'table':
    case 'view': {
      const object = ref.kind === 'table' ? ref.table : ref.view;
      return {
        kind: ref.kind,
        id: object.id,
        schemaId: ref.schema.id,
        old: object.name,
        label: `${ref.kind} ${ref.schema.name}.${object.name}`,
      };
    }
    case 'column': {
      const [column] = ref.path;
      if (ref.path.length !== 1 || ref.member || column === undefined) {
        return 'Rename... renames a table, a view or a top-level column of a table. A field of a struct is renamed with Script as ALTER.';
      }
      return {
        kind: 'column',
        id: ref.table.id,
        schemaId: ref.schema.id,
        column,
        old: column,
        label: `column ${ref.schema.name}.${ref.table.name}.${column}`,
      };
    }
    default:
      return undefined;
  }
}

/** The names, folded, that the new name may not take: the tables and views of the schema, or the columns of the table. */
export async function takenNames(
  reader: Pick<CatalogReader, 'entries' | 'columns'>,
  snapshot: SnapshotId,
  wanted: Wanted,
): Promise<ReadonlySet<string>> {
  const names =
    wanted.kind === 'column'
      ? (await reader.columns(wanted.id, snapshot)).map(({ name }) => name)
      : (await reader.entries(snapshot))
          .filter(({ schemaId }) => schemaId === wanted.schemaId)
          .map(({ name }) => name);
  return new Set(names.map(foldIdentifier));
}

/** Why a new name cannot be taken; undefined when it can. */
export function nameProblem(
  value: string,
  old: string,
  taken: ReadonlySet<string>,
  kind: Wanted['kind'],
): string | undefined {
  if (value.trim() === '') return 'Enter a name.';
  if (foldIdentifier(value) === foldIdentifier(old)) {
    return 'DuckDB compares names without the case of A to Z: enter another name.';
  }
  if (taken.has(foldIdentifier(value))) {
    return kind === 'column'
      ? 'The table has a column of this name.'
      : 'The schema has a table or view of this name.';
  }
  return undefined;
}

/** The syncs to Iceberg that hold the table, found by its id, or by its name for a sync recorded without the id. */
export function icebergSyncs(
  iceberg: {
    readonly copies: Pick<IcebergCopies, 'list'>;
    readonly targets: Pick<IcebergTargetStore, 'list'>;
  },
  connectionId: string,
  tableId: number,
  renamed: Renamed,
): IcebergSync[] {
  const targets = iceberg.targets.list();
  return iceberg.copies
    .list(connectionId)
    .filter(
      (record) =>
        record.tableId === tableId ||
        (record.tableId === undefined && record.schema === renamed.schema && record.table === renamed.name),
    )
    .map((record) => ({
      target: targets.find(({ id }) => id === record.targetId)?.name ?? record.targetId,
      namespace: record.icebergNamespace ?? record.schema,
      table: record.icebergTable ?? record.table,
      byName: record.tableId === undefined,
    }));
}
