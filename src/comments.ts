import { commentStatement } from './ddl-script/statements';
import { newestNote } from './script';
import type { CatalogTree } from './tree/model';
import type { NodeRef } from './tree/refs';

// Edit Comment: the COMMENT ON statement that aantje opens in a SQL document; nothing runs. Pure.

/** What a comment is set on: a table, a view or a top-level column of a table, with its comment at the shown snapshot. */
export interface CommentTarget {
  readonly what: 'TABLE' | 'VIEW' | 'COLUMN';
  /** Schema, relation and, for a column, its name. */
  readonly name: readonly string[];
  readonly current: string | null;
}

/** The target of a node; undefined for a node without a comment of its own, `nested` for a field inside a column. */
export function commentTargetOf(ref: NodeRef): CommentTarget | 'nested' | undefined {
  switch (ref.kind) {
    case 'table':
      return { what: 'TABLE', name: [ref.schema.name, ref.table.name], current: ref.table.comment };
    case 'view':
      return { what: 'VIEW', name: [ref.schema.name, ref.view.name], current: ref.view.comment };
    case 'column':
      // DuckLake keeps the comments of the top-level columns of a table only.
      return ref.path.length === 1 && ref.member !== true
        ? {
            what: 'COLUMN',
            name: [ref.schema.name, ref.table.name, ref.column.name],
            current: ref.column.comment,
          }
        : 'nested';
    default:
      return undefined;
  }
}

/**
 * The comment as one line of an input box: a line break is written `\n`, a backslash `\\`, so that every comment comes
 * back as it was.
 */
export const commentInput = (comment: string | null): string =>
  (comment ?? '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n');

/** The comment of an input: `\n` is a line break, `\\` a backslash; an input of blanks only is no comment. */
export function commentOfInput(input: string): string | null {
  const text = input.replace(/\\(\\|n)/g, (_match, escaped: string) => (escaped === 'n' ? '\n' : '\\'));
  return text.trim() === '' ? null : text;
}

/**
 * The script of Edit Comment: one `COMMENT ON` per changed target, under a note while the tree shows
 * an older snapshot (the statements change the newest state).
 */
export function commentScript(
  tree: Pick<CatalogTree, 'state'>,
  connectionId: string,
  changes: readonly { readonly target: CommentTarget; readonly comment: string | null }[],
): string {
  return [
    `-- Sets ${changes.length === 1 ? 'a comment' : 'the comments'}; NULL removes one. Run it in a read/write SQL session.`,
    ...newestNote(tree, connectionId, { several: changes.length > 1 }),
    ...changes.map(({ target, comment }) => commentStatement(target.what, target.name, comment)),
  ].join('\n');
}
