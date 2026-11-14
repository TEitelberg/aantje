import { foldIdentifier } from '../catalog/ddl';
import type { CatalogReader, DroppedObject, SchemaInfo, SnapshotId, SnapshotInfo } from '../catalog/model';
import { pickerLabel } from '../messages';
import { readCreatedTable, readPickedTable } from '../ddl-script/read';
import { snapshotChoices } from '../snapshot';
import type { SnapshotPickItem } from '../snapshot';
import type { Subject } from '../time-travel';
import { restoredName } from './dropped';
import type { DroppedDefinition, DroppedRestore } from './dropped';
import type { TableRestore } from './table';

// What the restore commands read, all from the catalog through the reader: no DuckDB engine and no data files.

/** A row of the snapshot picker with the snapshot it stands for. */
export type RestoreSnapshotItem = SnapshotPickItem<SnapshotId> & { readonly snapshot: SnapshotInfo };

/**
 * The snapshots that a table can be restored to: those at which it existed and that the catalog still has, newest
 * first, without the newest snapshot of the catalog. The description adds the author to the time.
 */
export async function restoreSnapshots(
  reader: Pick<CatalogReader, 'snapshots' | 'lifetime'>,
  subject: Subject,
  shown: SnapshotId | undefined,
): Promise<RestoreSnapshotItem[]> {
  const [snapshots, lifetime] = await Promise.all([reader.snapshots(), reader.lifetime('table', subject.id)]);
  const newest = snapshots[0]?.id;
  if (!lifetime) return [];
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  return snapshotChoices(snapshots, shown, lifetime).flatMap((row) => {
    const snapshot = byId.get(row.value);
    if (!snapshot || row.value === newest) return [];
    const author = snapshot.author === null ? '' : ` · ${pickerLabel(snapshot.author)}`;
    return [{ ...row, description: `${row.description}${author}`, snapshot }];
  });
}

type TableReads = Pick<
  CatalogReader,
  'info' | 'entries' | 'tables' | 'columns' | 'partitioning' | 'sortOrder'
>;

/** The table at the snapshot and at the newest one; undefined when it does not exist at the newest snapshot. */
export async function readTableRestore(
  reader: TableReads,
  subject: Subject,
  snapshot: SnapshotInfo,
  pinned: SnapshotId | undefined,
): Promise<TableRestore | undefined> {
  const latest = (await reader.info()).latestSnapshot;
  const entryAt = async (at: SnapshotId) =>
    (await reader.entries(at)).find(({ kind, id }) => kind === 'table' && id === subject.id);
  const [thenEntry, nowEntry] = await Promise.all([entryAt(snapshot.id), entryAt(latest)]);
  if (!thenEntry) {
    throw new Error(`The table does not exist at snapshot ${snapshot.id}.`);
  }
  if (!nowEntry) return undefined;
  const [then, now] = await Promise.all([
    readPickedTable(reader, snapshot.id, thenEntry),
    readPickedTable(reader, latest, nowEntry),
  ]);
  return { snapshot: { id: snapshot.id, time: snapshot.time }, then, now, pinned };
}

type DroppedReads = TableReads & Pick<CatalogReader, 'views' | 'macros' | 'metadata'>;

async function definitionOf(
  reader: DroppedReads,
  schema: SchemaInfo,
  object: DroppedObject,
): Promise<DroppedDefinition | undefined> {
  const at = object.lastSnapshot;
  switch (object.kind) {
    case 'table': {
      // The comment of a table comes with the tables of its schema.
      const [tables, metadata] = await Promise.all([reader.tables(schema.id, at), reader.metadata()]);
      const comment = tables.find(({ id }) => id === object.id)?.comment ?? null;
      const head = { id: object.id, schemaName: schema.name, name: object.name, comment };
      return { kind: 'table', table: await readCreatedTable(reader, at, head, metadata) };
    }
    case 'view': {
      const view = (await reader.views(schema.id, at)).find(({ id }) => id === object.id);
      return view && { kind: 'view', view };
    }
    case 'macro': {
      const macro = (await reader.macros(schema.id, at)).find(({ id }) => id === object.id);
      return macro && { kind: 'macro', macro };
    }
  }
}

/** The names in use in the schema now: tables and views share theirs, macros of one kind theirs. */
async function takenNames(
  reader: DroppedReads,
  schema: SchemaInfo,
  definition: DroppedDefinition,
): Promise<Set<string>> {
  const latest = (await reader.info()).latestSnapshot;
  if (definition.kind === 'macro') {
    const macros = await reader.macros(schema.id, latest);
    return new Set(
      macros.filter(({ kind }) => kind === definition.macro.kind).map(({ name }) => foldIdentifier(name)),
    );
  }
  const entries = await reader.entries(latest);
  return new Set(
    entries.filter(({ schemaId }) => schemaId === schema.id).map(({ name }) => foldIdentifier(name)),
  );
}

/** What the script of a dropped object needs, read at the last snapshot that has it. */
export async function readDroppedRestore(
  reader: DroppedReads,
  schema: SchemaInfo,
  object: DroppedObject,
): Promise<DroppedRestore> {
  const definition = await definitionOf(reader, schema, object);
  if (!definition) {
    throw new Error(`The ${object.kind} does not exist at snapshot ${object.lastSnapshot}.`);
  }
  const taken = await takenNames(reader, schema, definition);
  return { schemaName: schema.name, object, definition, name: restoredName(object.name, taken) };
}
