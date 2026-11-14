import { dropMacroDdl } from '../catalog/ddl';
import type { MacroInfo, ViewInfo } from '../catalog/model';
import { COMPARE_LIMITS } from '../compare';
import { checkedScript } from '../ddl-script/check';
import type { CatalogCheck, Tokenize } from '../ddl-script/check';
import { macroScript, viewScript } from '../ddl-script/definitions';
import { dropStatement } from '../ddl-script/statements';
import { createLines, tableDdl } from '../ddl-script/table-ddl';
import type { CreatedTable } from '../ddl-script/table-ddl';
import { tableUpdate, WARNINGS } from '../ddl-script/table-update';
import type { DependencyGraph } from '../dependencies/graph';
import { dependencyOrder } from '../dependencies/order';
import { macroNodeKind } from '../dependencies/graph';
import type { GraphKey } from '../dependencies/graph';
import type { SchemaComparison } from './schemas';
import type { Side } from './tables';
import { scriptHeader, targetDrops } from './update-table';

// Script as Update of two schemas. Drops come first, views and macros before the tables they read; creates come last,
// tables before the views and macros that read them, which the dependency graph of each side orders. Statements that
// copy catalog text of the source go through `check` (`checkedScript`).

export interface SchemaScriptInput {
  readonly source: Side & { readonly schemaName: string };
  readonly target: Side & { readonly schemaName: string };
  readonly comparison: SchemaComparison;
  /** The tables that only the source has, read in full, by id. */
  readonly created: ReadonlyMap<number, CreatedTable>;
  /** The dependency graph of each schema; undefined when it could not be read, and the order is that of the names. */
  readonly graphs: {
    readonly source: DependencyGraph | undefined;
    readonly target: DependencyGraph | undefined;
  };
}

/** A view or macro to drop or to create; `replaces` when the target has one of the name that differs. */
type Definition = ({ readonly view: ViewInfo } | { readonly macro: MacroInfo }) & {
  readonly replaces?: true;
};

const graphKey = (definition: Definition): GraphKey =>
  'view' in definition
    ? { kind: 'view', id: definition.view.id }
    : { kind: macroNodeKind(definition.macro), id: definition.macro.id };

const UNORDERED = '-- These go by name: which of them use which could not be read.';

function ordered(
  definitions: readonly Definition[],
  graph: DependencyGraph | undefined,
  direction: 'usedFirst' | 'usersFirst',
): { readonly notes: string[]; readonly definitions: Definition[] } {
  return {
    notes: !graph && definitions.length > 1 ? [UNORDERED] : [],
    definitions: dependencyOrder(definitions, graphKey, graph, direction),
  };
}

function dropLines({ comparison, target, graphs }: SchemaScriptInput): string[] {
  const { views, macros, tables } = comparison;
  const { notes, definitions } = ordered(
    [...views.onlyRight.map((view) => ({ view })), ...macros.onlyRight.map((macro) => ({ macro }))],
    graphs.target,
    'usersFirst',
  );
  const into = target.schemaName;
  const drops = targetDrops(target);
  const drop = (warning: string, statement: string): string[] => [
    warning,
    ...drops.note,
    drops.statement(statement),
  ];
  return [
    ...notes,
    ...definitions.flatMap((definition) =>
      'view' in definition
        ? drop(WARNINGS.dropView, dropStatement('VIEW', into, definition.view.name))
        : drop(WARNINGS.dropMacro, dropMacroDdl(into, definition.macro)),
    ),
    ...tables.onlyRight.flatMap(({ name }) => drop(WARNINGS.dropTable, dropStatement('TABLE', into, name))),
  ];
}

function definitionLines({ comparison, target, graphs }: SchemaScriptInput, check: CatalogCheck): string[] {
  const { views, macros } = comparison;
  const { notes, definitions } = ordered(
    [
      ...views.onlyLeft.map((view) => ({ view })),
      ...views.different.map(({ left }) => ({ view: left, replaces: true as const })),
      ...macros.onlyLeft.map((macro) => ({ macro })),
      ...macros.different.map(({ left }) => ({ macro: left, replaces: true as const })),
    ],
    graphs.source,
    'usedFirst',
  );
  return [
    ...notes,
    ...definitions.flatMap((definition) => {
      const made =
        'view' in definition
          ? viewScript(target.schemaName, definition.view, { head: 'replace', check })
          : macroScript(target.schemaName, definition.macro, { head: 'replace', check });
      return [...(definition.replaces ? [WARNINGS.replace] : []), ...made.notes, made.statement];
    }),
  ];
}

/**
 * Script as Update of two schemas: the statements that make the right schema like the left one, in an order that works.
 * DuckDB's tokenizer checks the statements that copy catalog text of the source (`checkedScript`); nothing runs.
 */
export function schemaScript(input: SchemaScriptInput, tokenize: Tokenize): Promise<string> {
  const { source, target, comparison, created } = input;
  const { tables } = comparison;
  const omitted =
    tables.omitted > 0
      ? [
          `-- ${tables.omitted} more tables in both were not compared (limit: ${COMPARE_LIMITS.tables}); this script leaves them as they are.`,
        ]
      : [];
  const header = [
    ...scriptHeader(
      'schema',
      { side: source, name: [source.schemaName] },
      { side: target, name: [target.schemaName] },
    ),
    ...omitted,
    '',
  ];
  return checkedScript((check) => {
    const sections = [
      dropLines(input),
      ...tables.different.map(({ left, right }) => tableUpdate(left, right, check, targetDrops(target))),
      tables.onlyLeft.flatMap((table) => {
        const read = created.get(table.id);
        return read ? createLines(tableDdl(target.schemaName, read, check)) : [];
      }),
      definitionLines(input, check),
    ].filter((lines) => lines.length > 0);
    return [
      ...header,
      ...(sections.length === 0
        ? ['-- The schemas do not differ: there is nothing to change.']
        : sections.flatMap((lines, index) => (index === 0 ? lines : ['', ...lines]))),
    ];
  }, tokenize);
}
