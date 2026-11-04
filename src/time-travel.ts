import type { CatalogReader, SnapshotId } from './catalog/model';
import { PREVIEW_LIMIT } from './data/types';
import type { TableRef } from './data/types';
import { snapshotChoices } from './snapshot';
import type { SnapshotPickItem } from './snapshot';
import type { ChangedTable, NodeRef } from './tree/refs';

export interface PickOptions<T> {
  readonly title: string;
  readonly placeholder: string;
  /** Rows highlighted when the picker opens. */
  readonly active?: readonly T[];
}

/** What the commands ask and tell the user; a cancelled pick gives undefined. */
export interface TimeTravelUi {
  pick<T extends { readonly label: string }>(
    items: readonly T[],
    options: PickOptions<T>,
  ): Promise<T | undefined>;
  info(message: string): void;
}

/** A table or view of the tree, named as at the snapshot the tree shows. */
export interface Subject {
  readonly kind: 'table' | 'view';
  readonly id: number;
  readonly schemaName: string;
  readonly name: string;
}

/** The table or view of a tree node; undefined for other nodes. */
export function subjectOf(ref: NodeRef): Subject | undefined {
  switch (ref.kind) {
    case 'table':
      return { kind: 'table', id: ref.table.id, schemaName: ref.schema.name, name: ref.table.name };
    case 'view':
      return { kind: 'view', id: ref.view.id, schemaName: ref.schema.name, name: ref.view.name };
    default:
      return undefined;
  }
}

export const subjectLabel = ({ schemaName, name }: Subject): string => `${schemaName}.${name}`;

/** The snapshots at which the table or view exists, newest first; preselects the one the tree shows. Exported for its test. */
export async function subjectSnapshots(
  reader: Pick<CatalogReader, 'snapshots' | 'lifetime'>,
  subject: Subject,
  shown: SnapshotId | undefined,
): Promise<SnapshotPickItem<SnapshotId>[]> {
  const [snapshots, lifetime] = await Promise.all([
    reader.snapshots(),
    reader.lifetime(subject.kind, subject.id),
  ]);
  return lifetime ? snapshotChoices(snapshots, shown, lifetime) : [];
}

type QueryAction = 'rows' | 'notebook' | 'sql';

interface QueryChoice {
  readonly snapshot: SnapshotId;
  readonly action: QueryAction;
  readonly table: TableRef;
}

const ACTIONS: readonly { label: string; description: string; value: QueryAction }[] = [
  { label: `Top ${PREVIEW_LIMIT} Rows`, description: 'Show the first rows in a grid', value: 'rows' },
  {
    label: 'Create Notebook',
    description: 'Open a notebook that is pinned to the snapshot',
    value: 'notebook',
  },
  {
    label: 'Open as SQL',
    description: 'Open the statement in a SQL editor, without running it',
    value: 'sql',
  },
];

/** Asks for the snapshot (only where the relation exists) and what to open; the relation is named as at that snapshot. */
export async function chooseQuery(
  ui: TimeTravelUi,
  reader: Pick<CatalogReader, 'snapshots' | 'lifetime' | 'entries'>,
  subject: Subject,
  shown: SnapshotId | undefined,
): Promise<QueryChoice | undefined> {
  const label = subjectLabel(subject);
  const rows = await subjectSnapshots(reader, subject, shown);
  if (rows.length === 0) {
    ui.info(`"${label}" exists at no snapshot that the catalog still has.`);
    return undefined;
  }
  const snapshot = await ui.pick(rows, {
    title: `Query ${label} at a snapshot`,
    placeholder: 'Choose the snapshot to read',
    active: rows.filter((row) => row.picked),
  });
  if (!snapshot) {
    return undefined;
  }
  return chooseQueryAction(ui, reader, subject, snapshot.value);
}

/** Asks what to open for an already known snapshot. Cancelling gives undefined. */
export async function chooseQueryAction(
  ui: TimeTravelUi,
  reader: Pick<CatalogReader, 'entries'>,
  subject: Subject,
  snapshot: SnapshotId,
): Promise<QueryChoice | undefined> {
  const action = await ui.pick(ACTIONS, {
    title: `Query ${subjectLabel(subject)} at @${snapshot}`,
    placeholder: 'Choose what to open',
  });
  return action && { snapshot, action: action.value, table: await tableAt(reader, subject, snapshot) };
}

/** Picks snapshot A, then B from the rest; `from` is the older. Fewer than two rows give a hint and undefined. */
export async function choosePair(
  ui: TimeTravelUi,
  rows: readonly SnapshotPickItem<SnapshotId>[],
  subject: string,
): Promise<{ readonly from: SnapshotId; readonly to: SnapshotId } | undefined> {
  if (rows.length < 2) {
    ui.info(`There are fewer than two snapshots of ${subject} to compare.`);
    return undefined;
  }
  const first = await ui.pick(rows, {
    title: `Compare ${subject} (1/2)`,
    placeholder: 'Choose snapshot A',
    active: rows.filter((row) => row.picked),
  });
  if (!first) {
    return undefined;
  }
  const rest = rows.filter((row) => row.value !== first.value);
  const second = await ui.pick(rest, {
    title: `Compare ${subject} (2/2)`,
    placeholder: `Choose the snapshot to compare @${first.value} with`,
    active: rest.slice(0, 1),
  });
  if (!second) {
    return undefined;
  }
  return first.value < second.value
    ? { from: first.value, to: second.value }
    : { from: second.value, to: first.value };
}

/** Changes after `from` up to and including `to`; `table` is named as at `to`, which `table_changes` needs. */
export interface ChangeChoice {
  readonly from: SnapshotId;
  readonly to: SnapshotId;
  readonly table: TableRef;
}

// Asks for the snapshot to compare against and the last one to include (newest preselected). Offers snapshots where
// the table exists plus the one before its creation, so the creating snapshot's rows can show.
// The start never lists the newest snapshot; the end lists only later ones.
export async function chooseChanges(
  ui: TimeTravelUi,
  reader: Pick<CatalogReader, 'snapshots' | 'lifetime' | 'entries'>,
  subject: Subject,
  shown: SnapshotId | undefined,
): Promise<ChangeChoice | undefined> {
  const label = subjectLabel(subject);
  const [snapshots, lifetime] = await Promise.all([reader.snapshots(), reader.lifetime('table', subject.id)]);
  const ends = lifetime ? snapshotChoices(snapshots, undefined, lifetime) : [];
  const newest = ends[0];
  const starts = lifetime
    ? snapshotChoices(snapshots, shown, { ...lifetime, begin: Math.max(lifetime.begin - 1, 0) }).filter(
        (row) => newest !== undefined && row.value < newest.value,
      )
    : [];
  if (!newest || starts.length === 0) {
    ui.info(
      newest
        ? `"${label}" has only one snapshot, so there are no changes to show.`
        : `"${label}" exists at no snapshot that the catalog still has.`,
    );
    return undefined;
  }
  const from = await ui.pick(starts, {
    title: `Show changes of ${label} (1/2)`,
    placeholder: 'Choose the snapshot to compare against: the changes made after it are shown',
    active: starts.filter((row) => row.picked),
  });
  if (!from) {
    return undefined;
  }
  const later = ends.filter((row) => row.value > from.value);
  const to = await ui.pick(later, {
    title: `Show changes of ${label} (2/2)`,
    placeholder: `Choose the last snapshot to include: the changes after @${from.value} up to it are shown`,
    active: later.slice(0, 1),
  });
  if (!to) {
    return undefined;
  }
  return { from: from.value, to: to.value, table: await tableAt(reader, subject, to.value) };
}

/** The range from a snapshot's predecessor to it; the first snapshot, or a table absent there, gives a hint and undefined. */
export async function changesOfSnapshot(
  ui: TimeTravelUi,
  reader: Pick<CatalogReader, 'entries'>,
  { snapshot, table }: ChangedTable,
): Promise<ChangeChoice | undefined> {
  if (snapshot === 0) {
    ui.info('@0 is the first snapshot of the catalog: there is no snapshot before it to compare with.');
    return undefined;
  }
  const exists = (await reader.entries(snapshot)).some(
    (entry) => entry.kind === 'table' && entry.schemaName === table.schema && entry.name === table.table,
  );
  if (!exists) {
    ui.info(
      `"${table.schema}.${table.table}" does not exist at snapshot @${snapshot} (it was dropped there or is not created yet), so it has no rows to show.`,
    );
    return undefined;
  }
  return { from: snapshot - 1, to: snapshot, table };
}

/** The names at the snapshot, which differ from the tree's after a rename; schemas, tables and views share one id counter. */
export async function namesAt(
  reader: Pick<CatalogReader, 'entries'>,
  subject: Subject,
  snapshot: SnapshotId,
): Promise<{ readonly schemaName: string; readonly name: string }> {
  const then = (await reader.entries(snapshot)).find((entry) => entry.id === subject.id);
  return { schemaName: then?.schemaName ?? subject.schemaName, name: then?.name ?? subject.name };
}

async function tableAt(
  reader: Pick<CatalogReader, 'entries'>,
  subject: Subject,
  snapshot: SnapshotId,
): Promise<TableRef> {
  const { schemaName, name } = await namesAt(reader, subject, snapshot);
  return { schema: schemaName, table: name };
}

/** Picks two snapshots at which the table or view exists. */
export async function chooseRange(
  ui: TimeTravelUi,
  reader: Pick<CatalogReader, 'snapshots' | 'lifetime'>,
  subject: Subject,
  shown: SnapshotId | undefined,
): Promise<{ readonly from: SnapshotId; readonly to: SnapshotId } | undefined> {
  return choosePair(ui, await subjectSnapshots(reader, subject, shown), `"${subjectLabel(subject)}"`);
}
