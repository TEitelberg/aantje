import { groupBy } from '../order';
import type { CatalogEntry, ColumnInfo } from './model';

interface ColumnChangeBase {
  /** Column id, unique per table (nested fields included). */
  readonly id: number;
  /** Names from the top-level column down to the column, as in `after` (`before` for a removed column). */
  readonly path: readonly string[];
}

/** One difference of one column between two states of a table. */
export type ColumnChange =
  | (ColumnChangeBase & { readonly change: 'added' | 'removed'; readonly type: string })
  /** `path` ends with the new name; `from` is the old name. Fields of a renamed struct are not reported again. */
  | (ColumnChangeBase & { readonly change: 'renamed'; readonly from: string })
  | (ColumnChangeBase & { readonly change: 'typeChanged'; readonly from: string; readonly to: string })
  | (ColumnChangeBase & { readonly change: 'nullableChanged'; readonly from: boolean; readonly to: boolean })
  | (ColumnChangeBase & {
      readonly change: 'defaultChanged' | 'commentChanged';
      readonly from: string | null;
      readonly to: string | null;
    })
  /** `from` and `to` are the positions among the siblings (the fields of the same parent), counted from 0. */
  | (ColumnChangeBase & { readonly change: 'moved'; readonly from: number; readonly to: number });

interface Placed {
  readonly column: ColumnInfo;
  readonly path: readonly string[];
  readonly parent: number | null;
  readonly index: number;
}

function place(
  columns: readonly ColumnInfo[],
  parent: number | null = null,
  prefix: readonly string[] = [],
  into = new Map<number, Placed>(),
): Map<number, Placed> {
  columns.forEach((column, index) => {
    const path = [...prefix, column.name];
    into.set(column.id, { column, path, parent, index });
    place(column.children, column.id, path, into);
  });
  return into;
}

/** The positions of one longest strictly increasing run of the values: the siblings that keep their order. */
export function longestIncreasing(values: readonly number[]): Set<number> {
  const runs: { readonly length: number; readonly previous: number }[] = [];
  for (const value of values) {
    let best = { length: 1, previous: -1 };
    runs.forEach((run, j) => {
      if ((values[j] ?? 0) < value && run.length + 1 > best.length) {
        best = { length: run.length + 1, previous: j };
      }
    });
    runs.push(best);
  }
  const kept = new Set<number>();
  let at = runs.reduce((top, run, i) => (run.length > (runs[top]?.length ?? 0) ? i : top), 0);
  while (at >= 0 && runs[at]) {
    kept.add(at);
    at = runs[at]?.previous ?? -1;
  }
  return kept;
}

// Moved: siblings present in both states that are outside the longest run keeping its relative order.
// Adding or dropping a sibling moves nobody.
function movedIds(before: ReadonlyMap<number, Placed>, after: ReadonlyMap<number, Placed>): Set<number> {
  const stayed = [...after].flatMap(([id, now]) => {
    const was = before.get(id);
    return was?.parent === now.parent ? [was] : [];
  });
  const byParent = groupBy(stayed, (was) => was.parent);
  const moved = new Set<number>();
  for (const siblings of byParent.values()) {
    const kept = longestIncreasing(siblings.map((sibling) => sibling.index));
    siblings.forEach((sibling, i) => {
      if (!kept.has(i)) {
        moved.add(sibling.column.id);
      }
    });
  }
  return moved;
}

/**
 * Differences between two states of a table, matched by column id. A column under another parent counts as removed and
 * added; a new struct is reported per field. Lists `after` columns in table order, then removed ones.
 */
export function diffColumns(before: readonly ColumnInfo[], after: readonly ColumnInfo[]): ColumnChange[] {
  const old = place(before);
  const next = place(after);
  const moved = movedIds(old, next);
  const changes: ColumnChange[] = [];

  for (const [id, now] of next) {
    const was = old.get(id);
    if (was?.parent !== now.parent) {
      changes.push({ change: 'added', id, path: now.path, type: now.column.type });
      continue;
    }
    const { path } = now;
    if (was.column.name !== now.column.name) {
      changes.push({ change: 'renamed', id, path, from: was.column.name });
    }
    if (was.column.type !== now.column.type) {
      changes.push({ change: 'typeChanged', id, path, from: was.column.type, to: now.column.type });
    }
    if (was.column.nullable !== now.column.nullable) {
      changes.push({
        change: 'nullableChanged',
        id,
        path,
        from: was.column.nullable,
        to: now.column.nullable,
      });
    }
    if (was.column.defaultValue !== now.column.defaultValue) {
      changes.push({
        change: 'defaultChanged',
        id,
        path,
        from: was.column.defaultValue,
        to: now.column.defaultValue,
      });
    }
    if (was.column.comment !== now.column.comment) {
      changes.push({ change: 'commentChanged', id, path, from: was.column.comment, to: now.column.comment });
    }
    if (moved.has(id)) {
      changes.push({ change: 'moved', id, path, from: was.index, to: now.index });
    }
  }
  for (const [id, was] of old) {
    const now = next.get(id);
    if (now?.parent !== was.parent) {
      changes.push({ change: 'removed', id, path: was.path, type: was.column.type });
    }
  }
  return changes;
}

interface QualifiedName {
  readonly schemaName: string;
  readonly name: string;
}

/** A table or view that appeared, disappeared or changed its qualified name between two states. */
export type EntryChange = Pick<CatalogEntry, 'kind' | 'id' | 'schemaName' | 'name'> &
  (
    | { readonly change: 'added' | 'dropped' }
    /** `schemaName` and `name` are the new ones; a move to another schema is a rename too. */
    | { readonly change: 'renamed'; readonly from: QualifiedName }
  );

/**
 * Tables and views added, dropped or renamed (or moved to another schema) between two states, matched by kind and id;
 * added and renamed first.
 */
export function diffEntries(before: readonly CatalogEntry[], after: readonly CatalogEntry[]): EntryChange[] {
  const key = (entry: CatalogEntry): string => `${entry.kind}:${entry.id}`;
  const old = new Map(before.map((entry) => [key(entry), entry]));
  const current = new Set(after.map(key));
  const changes: EntryChange[] = [];

  for (const entry of after) {
    const { kind, id, schemaName, name } = entry;
    const was = old.get(key(entry));
    if (!was) {
      changes.push({ change: 'added', kind, id, schemaName, name });
    } else if (was.schemaName !== schemaName || was.name !== name) {
      changes.push({
        change: 'renamed',
        kind,
        id,
        schemaName,
        name,
        from: { schemaName: was.schemaName, name: was.name },
      });
    }
  }
  for (const { kind, id, schemaName, name } of before) {
    if (!current.has(`${kind}:${id}`)) {
      changes.push({ change: 'dropped', kind, id, schemaName, name });
    }
  }
  return changes;
}
