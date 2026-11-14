import type { ChangeEntry, ChangeObject } from '../changes';
import { groupBy } from '../../order';
import type { Row, Value } from '../drivers/driver';
import type { ResolvedChange, SnapshotActivity } from '../model';
import * as queries from '../queries/history';
import { toNumber, toTextOrNull } from './rows';
import type { Attempt } from './rows';

/** Ids per lookup statement; PostgreSQL and SQLite cap the placeholders. */
const ID_CHUNK = 500;

/** The ids in groups of at most `ID_CHUNK`, one statement each. */
export const chunksOf = (ids: readonly number[]): number[][] =>
  Array.from({ length: Math.ceil(ids.length / ID_CHUNK) }, (_, index) =>
    ids.slice(index * ID_CHUNK, (index + 1) * ID_CHUNK),
  );

const OBJECT_KINDS: readonly queries.ObjectKind[] = ['schema', 'table', 'view', 'macro'];

// Lookup rows for one kind of object at one snapshot: by id, and created by the snapshot.
interface Found {
  readonly byId: readonly Row[];
  readonly created: readonly Row[];
}

const NOTHING_FOUND: Found = { byId: [], created: [] };

// Lookups for a range of snapshots: all versions of the objects behind the ids, and the objects that begin in it.
interface Versions {
  readonly versions: readonly Row[];
  readonly created: readonly Row[];
}

// `Versions` indexed: per object newest first, and per snapshot the objects that begin there.
interface VersionIndex {
  readonly byId: ReadonlyMap<Value | undefined, readonly Row[]>;
  readonly createdAt: ReadonlyMap<number, readonly Row[]>;
}

function objectKind(object: ChangeObject | null): queries.ObjectKind | undefined {
  switch (object) {
    case 'schema':
    case 'table':
    case 'view':
      return object;
    case 'scalar_macro':
    case 'table_macro':
      return 'macro';
    default:
      return undefined;
  }
}

const idsOf = (changes: readonly ChangeEntry[]): number[] =>
  changes.flatMap((change) => (change.id === null ? [] : [change.id]));

// The objects of the changes of the snapshots from `lowest` to `highest`, one entry per entry of `OBJECT_KINDS`: one
// statement per kind of object and id chunk, and one for the objects that begin in the range. One snapshot is the
// range from it to it.
async function lookUp(
  attempt: Attempt,
  changes: readonly ChangeEntry[],
  lowest: number,
  highest: number,
  signal?: AbortSignal,
): Promise<Versions[]> {
  return Promise.all(
    OBJECT_KINDS.map(async (kind) => {
      const ofKind = changes.filter((change) => objectKind(change.object) === kind);
      const ids = [...new Set(idsOf(ofKind))];
      const [byId, created] = await Promise.all([
        Promise.all(
          chunksOf(ids).map((chunk) => attempt(queries.objectVersions(kind, chunk, highest), signal)),
        ),
        ofKind.some((change) => change.name !== null)
          ? attempt(queries.objectsCreatedBetween(kind, lowest, highest), signal)
          : undefined,
      ]);
      return { versions: byId.flatMap((rows) => rows ?? []), created: created ?? [] };
    }),
  );
}

function indexVersions({ versions, created }: Versions): VersionIndex {
  const newestFirst = versions.toSorted((a, b) => toNumber(b.begin_snapshot) - toNumber(a.begin_snapshot));
  return {
    byId: groupBy(newestFirst, (row) => row.object_id),
    createdAt: groupBy(created, (row) => toNumber(row.begin_snapshot)),
  };
}

// What the lookups give for one change at its snapshot: the newest version of its object at or before it, and the
// objects of its kind that begin there.
function foundFor(indexes: readonly VersionIndex[], change: ChangeEntry, snapshot: number): Found {
  const kind = objectKind(change.object);
  const index = kind === undefined ? undefined : indexes[OBJECT_KINDS.indexOf(kind)];
  if (!index) return NOTHING_FOUND;
  const row = index.byId.get(change.id)?.find((candidate) => toNumber(candidate.begin_snapshot) <= snapshot);
  return { byId: row ? [row] : [], created: index.createdAt.get(snapshot) ?? [] };
}

// Names an entry: by id, or for `created_*` entries (which carry a name) by the objects that begin at the snapshot.
function resolveChange(change: ChangeEntry, found: Found): ResolvedChange {
  const base = { action: change.action, object: change.object, raw: change.raw };
  if (change.id !== null) {
    const row = found.byId.find((candidate) => candidate.object_id === change.id);
    return {
      ...base,
      objectId: change.id,
      schemaName: toTextOrNull(row?.schema_name ?? null),
      name: toTextOrNull(row?.object_name ?? null),
    };
  }
  if (change.name === null) {
    return { ...base, objectId: null, schemaName: null, name: null };
  }
  const kind = objectKind(change.object);
  const name = change.name.at(-1) ?? '';
  const schemaName = kind === undefined || kind === 'schema' ? null : (change.name.at(-2) ?? null);
  const row = found.created.find(
    (candidate) =>
      candidate.object_name === name && (kind === 'schema' || candidate.schema_name === schemaName),
  );
  return {
    ...base,
    action: row && toNumber(row.earlier) > 0 ? 'renamed' : change.action,
    objectId: row ? toNumber(row.object_id) : null,
    schemaName,
    name: kind === undefined ? change.name.join('.') : name,
  };
}

/** Names the objects of one snapshot's changes. */
export async function resolveChanges(
  attempt: Attempt,
  changes: readonly ChangeEntry[],
  snapshot: number,
): Promise<ResolvedChange[]> {
  const indexes = (await lookUp(attempt, changes, snapshot, snapshot)).map(indexVersions);
  return changes.map((change) => resolveChange(change, foundFor(indexes, change, snapshot)));
}

type Unresolved = Omit<SnapshotActivity, 'changes'> & { readonly changes: readonly ChangeEntry[] };

/** Names the objects of many snapshots' changes (newest first) in a few statements. */
export async function resolveActivity(
  attempt: Attempt,
  page: readonly Unresolved[],
  signal?: AbortSignal,
): Promise<SnapshotActivity[]> {
  const lowest = page.at(-1)?.id ?? 0;
  const highest = page[0]?.id ?? 0;
  const changes = page.flatMap((snapshot) => snapshot.changes);
  const indexes = (await lookUp(attempt, changes, lowest, highest, signal)).map(indexVersions);
  return page.map(({ changes: own, ...snapshot }) => ({
    ...snapshot,
    changes: own.map((change) => resolveChange(change, foundFor(indexes, change, snapshot.id))),
  }));
}
