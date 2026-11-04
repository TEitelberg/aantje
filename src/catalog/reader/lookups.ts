import type { ChangeEntry, ChangeObject } from '../changes';
import type { Row, Value } from '../drivers/driver';
import type { ResolvedChange, SnapshotActivity } from '../model';
import * as queries from '../queries/history';
import { toNumber, toTextOrNull } from './rows';
import type { Attempt } from './rows';

/** Ids per lookup statement; PostgreSQL and SQLite cap the placeholders. */
export const ID_CHUNK = 500;

/** The ids in groups of at most `ID_CHUNK`, one statement each. */
const chunksOf = (ids: readonly number[]): number[][] =>
  Array.from({ length: Math.ceil(ids.length / ID_CHUNK) }, (_, index) =>
    ids.slice(index * ID_CHUNK, (index + 1) * ID_CHUNK),
  );

const OBJECT_KINDS: readonly queries.ObjectKind[] = ['schema', 'table', 'view', 'macro'];

// Lookup rows for one kind of object: by id, and created by the snapshot.
interface Found {
  readonly byId: readonly Row[];
  readonly created: readonly Row[];
}

const NOTHING_FOUND: Found = { byId: [], created: [] };

// Lookups for many snapshots: all versions of the objects behind the ids, and the objects that begin in the range.
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

// One list of rows per entry of `OBJECT_KINDS`.
function lookUp(attempt: Attempt, changes: readonly ChangeEntry[], snapshot: number): Promise<Found[]> {
  return Promise.all(
    OBJECT_KINDS.map(async (kind) => {
      const ofKind = changes.filter((change) => objectKind(change.object) === kind);
      const ids = [...new Set(idsOf(ofKind))];
      const [byId, created] = await Promise.all([
        Promise.all(chunksOf(ids).map((chunk) => attempt(queries.objectsById(kind, chunk, snapshot)))),
        ofKind.some((change) => change.name !== null)
          ? attempt(queries.objectsCreatedAt(kind, snapshot))
          : undefined,
      ]);
      return { byId: byId.flatMap((rows) => rows ?? []), created: created ?? [] };
    }),
  );
}

// `lookUp` for many snapshots from `lowest` to `highest`: one statement per kind of object and id chunk.
async function lookUpAll(
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
  const byId = new Map<Value | undefined, Row[]>();
  for (const row of versions.toSorted((a, b) => toNumber(b.begin_snapshot) - toNumber(a.begin_snapshot))) {
    byId.set(row.object_id, [...(byId.get(row.object_id) ?? []), row]);
  }
  const createdAt = new Map<number, Row[]>();
  for (const row of created) {
    const begin = toNumber(row.begin_snapshot);
    createdAt.set(begin, [...(createdAt.get(begin) ?? []), row]);
  }
  return { byId, createdAt };
}

// What `lookUp` finds for one snapshot: the newest version at or before it per id, and the objects that begin there.
function foundAt(index: VersionIndex, snapshot: number, ids: readonly (number | null)[]): Found {
  const byId = ids.flatMap((id) => {
    const row = index.byId.get(id)?.find((candidate) => toNumber(candidate.begin_snapshot) <= snapshot);
    return row ? [row] : [];
  });
  return { byId, created: index.createdAt.get(snapshot) ?? [] };
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
  const found = await lookUp(attempt, changes, snapshot);
  return changes.map((change) => {
    const kind = objectKind(change.object);
    return resolveChange(
      change,
      found[kind === undefined ? -1 : OBJECT_KINDS.indexOf(kind)] ?? NOTHING_FOUND,
    );
  });
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
  const indexes = (
    await lookUpAll(
      attempt,
      page.flatMap(({ changes }) => changes),
      lowest,
      highest,
      signal,
    )
  ).map(indexVersions);
  return page.map(({ changes, ...snapshot }) => ({
    ...snapshot,
    changes: changes.map((change) => {
      const kind = objectKind(change.object);
      const index = kind === undefined ? undefined : indexes[OBJECT_KINDS.indexOf(kind)];
      return resolveChange(change, index ? foundAt(index, snapshot.id, [change.id]) : NOTHING_FOUND);
    }),
  }));
}
