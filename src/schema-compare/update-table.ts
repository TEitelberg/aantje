import { checkedScript } from '../ddl-script/check';
import type { Tokenize } from '../ddl-script/check';
import { commentName, commentText } from '../ddl-script/names';
import { dropsAtSnapshot } from '../ddl-script/statements';
import type { Drops } from '../ddl-script/statements';
import { tableUpdate } from '../ddl-script/table-update';
import type { Side, TableSide } from './tables';

// Script as Update of two tables: the statements of `tableUpdate` under a header that names both sides.

/**
 * The drops of a script for the target. Its names are those of the snapshot that the tree of the target shows: while
 * that is a chosen one, every drop is a comment (`dropsAtSnapshot`).
 */
export const targetDrops = (target: Side): Drops =>
  dropsAtSnapshot(target.pinned ? target.snapshot : undefined);

/** The first lines of a script: what it does, the two sides, and that it acts on the newest state of the target. */
export function scriptHeader(
  what: 'table' | 'schema',
  source: { readonly side: Side; readonly name: readonly string[] },
  target: { readonly side: Side; readonly name: readonly string[] },
): string[] {
  const named = ({ side, name }: typeof source): string =>
    `${commentText(side.connectionName)} · ${commentName(...name)} @${side.snapshot}`;
  return [
    `-- Script as Update: makes the ${what} on the right (target) like the ${what} on the left (source). Nothing has run: read the statements, change what you need and run them in a read/write SQL session.`,
    `-- Source: ${named(source)}. Target: ${named(target)}.`,
    ...(target.side.pinned
      ? [
          `-- The tree of the target shows snapshot @${target.side.snapshot}; the statements act on the newest state of the target.`,
        ]
      : []),
  ];
}

/**
 * Script as Update of two tables: the statements that make the right table like the left one. DuckDB's tokenizer
 * checks the statements that copy catalog text of the source (`checkedScript`); nothing runs.
 */
export function tablesScript(source: TableSide, target: TableSide, tokenize: Tokenize): Promise<string> {
  return checkedScript((check) => {
    const lines = tableUpdate(source.table, target.table, check, targetDrops(target));
    return [
      ...scriptHeader(
        'table',
        { side: source, name: [source.table.schemaName, source.table.name] },
        { side: target, name: [target.table.schemaName, target.table.name] },
      ),
      '',
      ...(lines.length === 0 ? ['-- The tables do not differ: there is nothing to change.'] : lines),
    ];
  }, tokenize);
}
