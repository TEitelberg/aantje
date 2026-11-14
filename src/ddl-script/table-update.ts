import { addColumnDdl, qualifiedName, quoteIdentifier, sqlType } from '../catalog/ddl';
import type { ColumnInfo } from '../catalog/model';
import { columnFragments, commented, isStatement, needing, typeFragments } from './check';
import type { CatalogCheck } from './check';
import { foldIdentifier } from '../catalog/ddl';
import { indexByName, commentName, mentions } from './names';
import {
  commentStatement,
  dropColumnStatement,
  dropsAtSnapshot,
  partitionKey,
  resetStatement,
  setStatement,
  SORT_NOTE,
  sortKey,
} from './statements';
import type { Drops } from './statements';
import { kindOf, layoutDiffers, movedNames, typeDiffers } from './table-state';
import type { TableState } from './table-state';
import { typeChangeAllowed } from './types';

// The ALTER TABLE statements that make a target table like a source table: Script as Update of Schema Compare, the
// partitioning, sort order and comments of a new table, and the structure steps of Restore Table to Snapshot. Comment
// lines hold fixed text or names in their quoted form on one line (`commentName`); a statement below a warning carries
// the name. A statement that copies catalog text goes through `check`, which may comment it out; a statement that needs
// one that stays a comment (an added column, a type change) is commented out too, so the script runs through as it
// shows.

export const WARNINGS = {
  dropColumn: '-- Warning: this drops a column and the data in it.',
  dropTable: '-- Warning: this drops a table and the data in it.',
  type: '-- Warning: this changes the type of a column; DuckLake reads the stored values as the new type, which can lose precision.',
  dropView: '-- Warning: this drops a view.',
  dropMacro: '-- Warning: this drops a macro with all its overloads.',
  replace: '-- Warning: this replaces the definition that the target has.',
};

const NOT_WIDER =
  '-- Not changed: DuckLake changes a column only to a wider type (INTEGER to BIGINT, DATE to TIMESTAMP and the like), and this change is not one. The statement is left as a comment.';
const NOT_NULL_NOTE = '-- SET NOT NULL fails while the column holds NULL values.';

/**
 * One line of the update: a statement, a statement left as a comment, or a comment line. `note` marks the notes that a
 * caller may write differently: `notWider` above a type change that DuckLake refuses, `sort` above `SET SORTED BY`.
 */
export interface Step {
  readonly text: string;
  readonly note?: 'notWider' | 'sort';
}

const plain = (lines: readonly string[]): Step[] => lines.map((text) => ({ text }));

/** The text of the steps, one entry per line or statement (`isStatement`). */
export const stepLines = (steps: readonly Step[]): string[] => steps.map(({ text }) => text);

/** Top-level columns, by `foldIdentifier`, that a statement which stays a comment would add, or would give the source type. */
interface Missing {
  readonly added: Set<string>;
  readonly retyped: Set<string>;
}

/** A top-level column whose type, or the type of a field below it, changes. */
interface Retype {
  readonly name: string;
  readonly source: ColumnInfo;
  readonly target: ColumnInfo;
  allowed: boolean;
}

interface Plan {
  /** Columns and fields that only the source has: the path names existing parents as the target does. */
  readonly adds: { readonly path: readonly string[]; readonly column: ColumnInfo }[];
  /** Target paths of the columns and fields that only the target has. */
  readonly drops: (readonly string[])[];
  readonly retypes: Map<string, Retype>;
  /** Target paths of the columns that keep another position than in the source after the script. */
  readonly moved: (readonly string[])[];
}

function planLevel(
  source: readonly ColumnInfo[],
  target: readonly ColumnInfo[],
  prefix: readonly string[],
  top: Omit<Retype, 'allowed'> | undefined,
  plan: Plan,
): void {
  const targets = indexByName(target);
  const sources = indexByName(source);
  for (const column of source) {
    const match = targets.get(foldIdentifier(column.name));
    if (!match) {
      plan.adds.push({ path: [...prefix, column.name], column });
      continue;
    }
    const at = top ?? { name: match.name, source: column, target: match };
    if (typeDiffers(match, column)) {
      // Only a leaf type can widen; a nested column of another kind stays.
      const allowed =
        kindOf(match.type) === 'leaf' &&
        kindOf(column.type) === 'leaf' &&
        typeChangeAllowed(match.type, column.type);
      const known = plan.retypes.get(foldIdentifier(at.name));
      if (known) known.allowed &&= allowed;
      else plan.retypes.set(foldIdentifier(at.name), { ...at, allowed });
    } else if (kindOf(column.type) !== 'leaf') {
      planLevel(column.children, match.children, [...prefix, match.name], at, plan);
    }
  }
  for (const column of target) {
    if (!sources.has(foldIdentifier(column.name))) plan.drops.push([...prefix, column.name]);
  }
  // DuckLake adds a column at the end and moves none: what is out of place after the script stays so.
  const after = [
    ...target.filter(({ name }) => sources.has(foldIdentifier(name))),
    ...source.filter(({ name }) => !targets.has(foldIdentifier(name))),
  ].map(({ name }) => name);
  const moved = movedNames(
    source.map(({ name }) => name),
    after,
  );
  plan.moved.push(
    ...after.filter((name) => moved.has(foldIdentifier(name))).map((name) => [...prefix, name]),
  );
}

/** The source column with the names of the target's fields: the statements before have aligned them. */
function withTargetNames(source: ColumnInfo, target: ColumnInfo | undefined): ColumnInfo {
  const fields = indexByName(target?.children ?? []);
  return {
    ...source,
    children: source.children.map((child) => {
      const match = fields.get(foldIdentifier(child.name));
      return { ...withTargetNames(child, match), name: match?.name ?? child.name };
    }),
  };
}

// An added column is a statement of its own per line: the script splits into exactly the statements it shows.
function addLines(target: TableState, plan: Plan, check: CatalogCheck, missing: Missing): string[] {
  return plan.adds.flatMap(({ path, column }) => {
    const { statements, notes } = addColumnDdl(target.schemaName, target.name, path, column);
    const added = check(statements.join('\n'), columnFragments([column]));
    if (isStatement(added.statement)) return [...notes, ...added.notes, ...statements];
    // A field that is not added leaves its top-level column with another type than in the source.
    (path.length > 1 ? missing.retyped : missing.added).add(foldIdentifier(path[0] ?? ''));
    return [...notes, ...added.notes, added.statement];
  });
}

// The new type of a column also drops the fields that it lacks: it needs a field drop that stays a comment (`kept`).
function retypeLines(
  table: string,
  plan: Plan,
  check: CatalogCheck,
  missing: Missing,
  kept: ReadonlySet<string>,
): Step[] {
  return [...plan.retypes.values()].flatMap(({ name, source, target, allowed }): Step[] => {
    const type = sqlType(withTargetNames(source, target));
    const statement = `ALTER TABLE ${table} ALTER COLUMN ${quoteIdentifier(name)} TYPE ${type};`;
    if (!allowed) {
      missing.retyped.add(foldIdentifier(name));
      return [{ text: NOT_WIDER, note: 'notWider' }, { text: commented(statement) }];
    }
    if (kept.has(foldIdentifier(name))) {
      missing.retyped.add(foldIdentifier(name));
      return plain([WARNINGS.type, ...needing(statement)]);
    }
    const typed = check(statement, typeFragments(source));
    if (!isStatement(typed.statement)) missing.retyped.add(foldIdentifier(name));
    return plain([WARNINGS.type, ...typed.notes, typed.statement]);
  });
}

// NOT NULL and the default of the top-level columns that both tables have. The default of the source fits the type
// of the source: on a column that keeps the type of the target it stays a comment.
function constraintLines(
  table: string,
  source: TableState,
  target: TableState,
  check: CatalogCheck,
  missing: Missing,
): string[] {
  const targets = indexByName(target.columns);
  return source.columns.flatMap((column) => {
    const match = targets.get(foldIdentifier(column.name));
    if (!match) return [];
    const alter = `ALTER TABLE ${table} ALTER COLUMN ${quoteIdentifier(match.name)}`;
    const nullability =
      column.nullable === match.nullable
        ? []
        : column.nullable
          ? [`${alter} DROP NOT NULL;`]
          : [NOT_NULL_NOTE, `${alter} SET NOT NULL;`];
    if (column.defaultValue === match.defaultValue) return nullability;
    if (column.defaultValue === null) return [...nullability, `${alter} DROP DEFAULT;`];
    const statement = `${alter} SET DEFAULT ${column.defaultValue};`;
    if (missing.retyped.has(foldIdentifier(match.name))) return [...nullability, ...needing(statement)];
    const set = check(statement, [column.defaultValue]);
    return [...nullability, ...set.notes, set.statement];
  });
}

/** The steps of one layout, and whether the layout that the target has is replaced (live) or stays. */
interface Layout {
  readonly steps: Step[];
  readonly live: boolean;
}

function partitionLines(source: TableState, target: TableState, absent: (name: string) => boolean): Layout {
  const keys = source.partitioning?.columns ?? [];
  if (keys.length === 0) {
    return { steps: plain([resetStatement(target.schemaName, target.name, 'PARTITIONED')]), live: true };
  }
  const set = setStatement(target.schemaName, target.name, 'PARTITIONED', keys.map(partitionKey));
  if (!isStatement(set)) return { steps: plain([set]), live: false };
  return keys.some(({ path }) => absent(path[0] ?? ''))
    ? { steps: plain(needing(set)), live: false }
    : { steps: plain([set]), live: true };
}

const SORT: Step = { text: SORT_NOTE, note: 'sort' };

// A sort expression is catalog text: it needs a column when it can name it (`mentions`).
function sortLines(
  source: TableState,
  target: TableState,
  check: CatalogCheck,
  absent: (name: string) => boolean,
): Layout {
  const sort = source.sortOrder?.expressions ?? [];
  if (sort.length === 0) {
    return { steps: plain([resetStatement(target.schemaName, target.name, 'SORTED')]), live: true };
  }
  const set = setStatement(target.schemaName, target.name, 'SORTED', sort.map(sortKey));
  if (!isStatement(set)) return { steps: plain([set]), live: false };
  const needed = source.columns.some(
    ({ name }) => absent(name) && sort.some(({ expression }) => mentions(expression, name)),
  );
  if (needed) return { steps: [SORT, ...plain(needing(set))], live: false };
  const made = check(
    set,
    sort.map(({ expression }) => expression),
  );
  return isStatement(made.statement)
    ? { steps: [SORT, { text: made.statement }], live: true }
    : { steps: plain([...made.notes, made.statement]), live: false };
}

/**
 * The partitioning and the sort order of the source. `keeps` tells a top-level column of the target that its layout
 * still uses after the script, because the statement that would replace that layout stays a comment.
 */
function layoutLines(
  source: TableState,
  target: TableState,
  check: CatalogCheck,
  missing: Missing,
): { readonly steps: Step[]; readonly keeps: (name: string) => boolean } {
  const differs = layoutDiffers(source, target);
  const absent = (name: string): boolean =>
    missing.added.has(foldIdentifier(name)) || missing.retyped.has(foldIdentifier(name));
  const unchanged: Layout = { steps: [], live: true };
  const partition = differs.partitioning ? partitionLines(source, target, absent) : unchanged;
  const sort = differs.sortOrder ? sortLines(source, target, check, absent) : unchanged;
  const keeps = (name: string): boolean =>
    (!partition.live &&
      (target.partitioning?.columns ?? []).some(
        ({ path }) => foldIdentifier(path[0] ?? '') === foldIdentifier(name),
      )) ||
    (!sort.live &&
      (target.sortOrder?.expressions ?? []).some(({ expression }) => mentions(expression, name)));
  return { steps: [...partition.steps, ...sort.steps], keeps };
}

// The comment of the table and of the top-level columns, also of the columns that the script adds.
function commentLines(source: TableState, target: TableState, missing: Missing): string[] {
  const targets = indexByName(target.columns);
  return [
    ...(source.comment === target.comment
      ? []
      : [commentStatement('TABLE', [target.schemaName, target.name], source.comment)]),
    ...source.columns.flatMap((column) => {
      const match = targets.get(foldIdentifier(column.name));
      if ((match?.comment ?? null) === column.comment) return [];
      const name = [target.schemaName, target.name, match?.name ?? column.name];
      const statement = commentStatement('COLUMN', name, column.comment);
      return !match && missing.added.has(foldIdentifier(column.name)) ? needing(statement) : [statement];
    }),
  ];
}

/**
 * The steps that make the target table like the source: columns and fields added, retyped (only to a wider type),
 * NOT NULL and defaults, partitioning and sort order, columns dropped once nothing sorts or partitions by them, and the
 * comments. What DuckLake cannot do is a comment, and so is what needs a statement that stays a comment. `drops` writes
 * the drops of columns and fields: comments while the tree of the target is pinned to a snapshot (`dropsAtSnapshot`).
 * Empty when the tables do not differ.
 */
export function tableSteps(
  source: TableState,
  target: TableState,
  check: CatalogCheck,
  drops: Drops = dropsAtSnapshot(undefined),
): Step[] {
  const plan: Plan = { adds: [], drops: [], retypes: new Map(), moved: [] };
  planLevel(source.columns, target.columns, [], undefined, plan);
  const table = qualifiedName(target.schemaName, target.name);
  const drop = (path: readonly string[]): string[] => [
    WARNINGS.dropColumn,
    ...drops.note,
    drops.statement(dropColumnStatement(target.schemaName, target.name, path)),
  ];
  const missing: Missing = { added: new Set(), retyped: new Set() };
  // In this order: each step reads what the steps before left as a comment.
  const adds = addLines(target, plan, check, missing);
  // A dropped field is not part of the new type of its column below.
  const fields = plan.drops.filter((path) => path.length > 1);
  const kept = new Set(drops.live ? [] : fields.map((path) => foldIdentifier(path[0] ?? '')));
  const retypes = retypeLines(table, plan, check, missing, kept);
  const constraints = constraintLines(table, source, target, check, missing);
  const layout = layoutLines(source, target, check, missing);
  // DuckLake refuses to drop a column that the table is still partitioned or sorted by.
  const columnDrops = plan.drops
    .filter((path) => path.length === 1)
    .flatMap((path) =>
      drops.live && layout.keeps(path[0] ?? '')
        ? [WARNINGS.dropColumn, ...needing(dropColumnStatement(target.schemaName, target.name, path))]
        : drop(path),
    );
  return [
    ...plain([...adds, ...fields.flatMap(drop)]),
    ...retypes,
    ...plain(constraints),
    ...layout.steps,
    ...plain([
      ...columnDrops,
      ...commentLines(source, target, missing),
      ...(plan.moved.length === 0
        ? []
        : [
            `-- DuckLake cannot move a column, so these keep another position than in the source: ${plan.moved.map((path) => commentName(...path)).join(', ')}.`,
          ]),
    ]),
  ];
}

/** `tableSteps` as the lines of a script: one entry per line or statement (`isStatement`). */
export const tableUpdate = (
  source: TableState,
  target: TableState,
  check: CatalogCheck,
  drops?: Drops,
): string[] => stepLines(tableSteps(source, target, check, drops));
