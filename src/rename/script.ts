// The script of a rename: the ALTER statement and the CREATE OR REPLACE statements of the views and macros that name
// the renamed object, in one transaction, under notes on what is left as it is and what a sync to Iceberg does. The
// statements of the views and macros are those of Generate Scripts, with their comments and dialect notes, and their
// catalog text goes through DuckDB's tokenizer (`checkedScript`). Comment lines hold fixed text, numbers and quoted names.
import { qualifiedName, quoteIdentifier } from '../catalog/ddl';
import type { SnapshotId } from '../catalog/model';
import { allNeeding, checkedScript, commented, isStatement } from '../ddl-script/check';
import type { Tokenize } from '../ddl-script/check';
import { macroLines, viewLines } from '../ddl-script/definitions';
import { commentName, commentText } from '../ddl-script/names';
import type { DependencyNode } from '../dependencies/graph';
import type { LeftReason, RenameChange, RenamePlan } from './plan';

/** What is renamed, by its names at the newest snapshot. */
export type Renamed =
  | { readonly kind: 'table' | 'view'; readonly schema: string; readonly name: string }
  | { readonly kind: 'column'; readonly schema: string; readonly name: string; readonly column: string };

/** A sync to Iceberg that holds the renamed table, by the name of its target and the Iceberg table it writes. */
export interface IcebergSync {
  readonly target: string;
  readonly namespace: string;
  readonly table: string;
  /** Kept by an older aantje without the id of the table: the sync finds the table by its name only. */
  readonly byName: boolean;
}

export interface RenameScriptInput {
  readonly renamed: Renamed;
  readonly name: string;
  /** The newest snapshot, which the script is written for. */
  readonly snapshot: SnapshotId;
  /** The snapshot that the tree shows, when it is pinned to another. */
  readonly pinned: SnapshotId | undefined;
  readonly plan: RenamePlan;
  readonly nodes: readonly DependencyNode[];
  readonly syncs: readonly IcebergSync[];
}

const KIND_WORD: Readonly<Record<DependencyNode['kind'], string>> = {
  table: 'table',
  view: 'view',
  scalarMacro: 'scalar macro',
  tableMacro: 'table macro',
};

const REASON: Readonly<Record<LeftReason, string>> = {
  unread:
    'DuckDB cannot read its SQL (another dialect, a syntax error, too long), and its text holds the old name',
  dynamic: 'it looks up a table at run time, with the old name in a string',
  fixed:
    'it names the column in USING, NATURAL, EXCLUDE, REPLACE or RENAME, which the script does not change',
  unresolved:
    'it has a name that the analysis cannot tie to a relation, or columns it cannot tell, which may be the renamed column',
  changes: 'its changed SQL would read something else or not bind',
  captures: 'a name in it would read the renamed object after the rename',
  notFound: 'the old name is not where DuckDB places the reference in its text',
};

/** The ALTER statement of the rename; names are quoted. */
export function renameStatement(renamed: Renamed, name: string): string {
  switch (renamed.kind) {
    case 'column':
      return `ALTER TABLE ${qualifiedName(renamed.schema, renamed.name)} RENAME COLUMN ${quoteIdentifier(renamed.column)} TO ${quoteIdentifier(name)};`;
    case 'view':
      return `ALTER VIEW ${qualifiedName(renamed.schema, renamed.name)} RENAME TO ${quoteIdentifier(name)};`;
    default:
      return `ALTER TABLE ${qualifiedName(renamed.schema, renamed.name)} RENAME TO ${quoteIdentifier(name)};`;
  }
}

const what = (renamed: Renamed): string =>
  renamed.kind === 'column'
    ? `the column ${commentName(renamed.column)} of the table ${commentName(renamed.schema, renamed.name)}`
    : `the ${renamed.kind} ${commentName(renamed.schema, renamed.name)}`;

const nodeName = (nodes: readonly DependencyNode[], node: number): string => {
  const found = nodes[node];
  return found ? `${commentName(found.schema, found.name)} (${KIND_WORD[found.kind]})` : '';
};

// What the next sync to Iceberg does with the renamed table (`iceberg/sync-plan.ts`, `iceberg/status.ts`).
function icebergNotes(input: RenameScriptInput): string[] {
  const { renamed, syncs } = input;
  if (syncs.length === 0 || renamed.kind === 'view') return [];
  return syncs.flatMap(({ target, namespace, table, byName }) => {
    const synced = `-- Iceberg: the table is synced to ${commentText(target)} as ${commentName(namespace, table)}.`;
    if (renamed.kind === 'column') {
      return [
        synced,
        '--   The next sync takes the renamed column as a change of the columns: it drops the Iceberg table and writes it new, so its snapshot history in Iceberg starts again.',
      ];
    }
    return byName
      ? [
          synced,
          '--   This sync was recorded by name only: the next sync counts the table as dropped and leaves the Iceberg table alone; a sync of the lake or the schema writes the renamed table as a new Iceberg table.',
        ]
      : [
          synced,
          '--   The next sync writes nothing for the rename: the Iceberg table keeps its name, and later syncs write the rows of the renamed table into it.',
        ];
  });
}

function header(input: RenameScriptInput): string[] {
  const { plan, nodes } = input;
  const left = plan.left.map(({ node, reason }) => `--   ${nodeName(nodes, node)}: ${REASON[reason]}.`);
  const columns = plan.columns.map(
    ({ node, from, to, star }) =>
      `--   ${commentName(nodes[node]?.schema ?? '', nodes[node]?.name ?? '', from)} is now ${commentName(to)}${star ? ' (the view selects *; its SQL stays as it is)' : ''}.`,
  );
  return [
    `-- Rename ${what(input.renamed)} to ${commentName(input.name)}, with the views and macros that name it, at snapshot ${input.snapshot}. Nothing has run: read the statements, then run them in a read/write SQL session.`,
    '-- One transaction: the rename and the changed views and macros are one snapshot. The names have no catalog prefix: run the script where the lake is the default catalog (USE lake;).',
    ...(input.pinned === undefined
      ? []
      : [
          `-- The tree shows snapshot @${input.pinned}; a rename acts on the newest state, which this script is written for (@${input.snapshot}).`,
        ]),
    ...icebergNotes(input),
    ...(left.length === 0 ? [] : ['-- Left as they are; check them before you run the script:', ...left]),
    ...(columns.length === 0
      ? []
      : ['-- These columns of views get a new name with the rename:', ...columns]),
  ];
}

// The lines of a changed view or macro: what it is, then its statements as Generate Scripts writes them.
function changeLines(
  change: RenameChange,
  nodes: readonly DependencyNode[],
  options: Parameters<typeof viewLines>[2],
): string[] {
  const schema = nodes[change.node]?.schema ?? '';
  const lines =
    change.kind === 'view'
      ? viewLines(schema, change.view, options)
      : macroLines(schema, change.macro, options);
  return [`-- used by ${nodeName(nodes, change.node)}`, ...lines];
}

const ALTER_HELD =
  '-- A view or macro below stays a comment, so the rename stays one too: remove the "-- " in front of the statements once you have read them.';

/** The script; DuckDB's tokenizer checks the catalog text that it copies, nothing runs. */
export async function renameScript(input: RenameScriptInput, tokenize: Tokenize): Promise<string> {
  const { plan, nodes } = input;
  const statement = renameStatement(input.renamed, input.name);
  return checkedScript((check) => {
    const sections = plan.changes.map((change) => changeLines(change, nodes, { head: 'replace', check }));
    // The views and macros must change with the rename, or they break: when one stays a comment, all do.
    const held = sections.some(
      (lines) => !lines.some((line) => isStatement(line) && line.startsWith('CREATE')),
    );
    const body = sections.flatMap((lines) => ['', ...(held ? allNeeding(lines) : lines)]);
    return [
      ...header(input),
      'BEGIN;',
      ...(held ? [ALTER_HELD, commented(statement)] : [statement]),
      ...body,
      '',
      'COMMIT;',
    ];
  }, tokenize);
}
