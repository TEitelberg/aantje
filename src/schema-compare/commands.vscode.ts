import * as vscode from 'vscode';
import { catalogAt, shownSnapshot } from '../actions';
import type { ActiveConnection } from '../active-connection.vscode';
import { showConnectFirst } from '../command.vscode';
import type { Register } from '../command.vscode';
import type { CatalogReader, SchemaInfo } from '../catalog/model';
import type { SchemaDocuments } from '../compare.vscode';
import type { ConnectionStore } from '../connections/store';
import type { Tokenize } from '../ddl-script/check';
import { readPickedTable } from '../ddl-script/read';
import type { TableState } from '../ddl-script/table-state';
import type { DependencyGraph } from '../dependencies/graph';
import { scriptGraph } from '../dependencies/order';
import type { SqlParser, SqlTokenizer } from '../dependencies/parser';
import type { Logger } from '../log';
import { pickOne } from '../pick.vscode';
import { cancellable } from '../progress.vscode';
import type { CatalogTree } from '../tree/model';
import { hasDifferences } from './model';
import { MODES, schemaItems, tableItems } from './picks';
import type { Mode, Picked, SideItem } from './picks';
import { readSchemas, readScriptParts } from './read';
import type { ReadSide } from './read';
import { schemaReport, schemaSummary } from './report';
import type { SchemaSide } from './report';
import { compareSchemas, differs, graphObjects } from './schemas';
import type { Paired, SchemaComparison, SchemaObjects } from './schemas';
import { compareTwoTables } from './tables';
import type { Side, TableSide } from './tables';
import { schemaScript } from './update-schema';
import { tablesScript } from './update-table';

interface SchemaCompareEnv {
  readonly tree: Pick<CatalogTree, 'state' | 'reader'>;
  readonly store: Pick<ConnectionStore, 'list'>;
  readonly active: Pick<ActiveConnection, 'current'>;
  readonly schemaDocuments: Pick<SchemaDocuments, 'show' | 'preview'>;
  /** Opens the text in a new SQL document bound to the connection, and runs nothing. */
  readonly openSql: (connectionId: string, text: string) => Promise<void>;
  readonly logger: Logger;
  readonly register: Register;
  /**
   * Parses the SQL of views and macros for the order of a schema script and tokenizes the statements of a script that
   * copy catalog text; it runs nothing.
   */
  readonly parser: SqlParser & SqlTokenizer;
}

/** The two schemas as read, ready to be compared again the other way round. */
interface SchemaPair {
  readonly left: SchemaSide & { readonly objects: SchemaObjects };
  readonly right: SchemaSide & { readonly objects: SchemaObjects };
  readonly compared: readonly Paired<TableState>[];
  readonly omitted: number;
}

const COMMAND = 'aantje.schemaCompare';
const GOAL = 'compare tables or schemas';
const SCRIPT = 'Script as Update';
const SWAP = 'Swap Sides';

const swapped = <T>({ left, right }: Paired<T>): Paired<T> => ({ left: right, right: left });

// The reader of a side; the side keeps the snapshot it was read at.
const readerOf = (env: SchemaCompareEnv, side: Side): CatalogReader =>
  catalogAt(env.tree, side.connectionId, GOAL, side.connectionName).reader;

const tokenizer =
  (env: SchemaCompareEnv): Tokenize =>
  (text) =>
    env.parser.tokenize(text);

/** The connected catalogs at the snapshot that their trees show, the connection in use first. */
function connected({ tree, store, active }: SchemaCompareEnv): Side[] {
  const inUse = active.current()?.id;
  return store
    .list()
    .flatMap((profile) => {
      const state = tree.state(profile.id);
      const snapshot = tree.reader(profile.id) ? shownSnapshot(state) : undefined;
      return snapshot === undefined
        ? []
        : [
            {
              connectionId: profile.id,
              connectionName: profile.name,
              snapshot,
              pinned: state.snapshot !== 'latest',
            },
          ];
    })
    .toSorted((a, b) => Number(b.connectionId === inUse) - Number(a.connectionId === inUse));
}

async function sideItems(env: SchemaCompareEnv, mode: Mode, sides: readonly Side[]): Promise<SideItem[]> {
  const perSide = await Promise.all(
    sides.map(async (side) => {
      const reader = readerOf(env, side);
      return mode === 'tables'
        ? tableItems(side, await reader.entries(side.snapshot))
        : schemaItems(side, await reader.schemas(side.snapshot));
    }),
  );
  return perSide.flat();
}

/** The message with the buttons; without a difference there is nothing to script or to swap. */
async function choose(summary: string, different: boolean): Promise<string | undefined> {
  if (!different) {
    void vscode.window.showInformationMessage(summary);
    return undefined;
  }
  return vscode.window.showInformationMessage(summary, SCRIPT, SWAP);
}

async function compareTables(env: SchemaCompareEnv, source: Picked, target: Picked): Promise<void> {
  const read = async (picked: Picked): Promise<TableSide> => {
    if (!('table' in picked)) throw new Error('Schema Compare of two tables got a schema.');
    const table = await readPickedTable(readerOf(env, picked.side), picked.side.snapshot, picked.table);
    return { ...picked.side, table };
  };
  let [left, right] = await cancellable('Comparing the tables...', () =>
    Promise.all([read(source), read(target)]),
  );
  for (;;) {
    const comparison = compareTwoTables(left, right);
    await env.schemaDocuments.show(comparison);
    const choice = await choose(comparison.summary, hasDifferences(comparison.differences));
    if (choice === SWAP) {
      [left, right] = [right, left];
      continue;
    }
    if (choice === SCRIPT) {
      await env.openSql(right.connectionId, await tablesScript(left, right, tokenizer(env)));
    }
    return;
  }
}

const readSide = (env: SchemaCompareEnv, side: Side, schema: SchemaInfo): ReadSide => ({
  reader: readerOf(env, side),
  snapshot: side.snapshot,
  schema,
});

// The order of views and macros comes from the dependency graph; without it the script goes by name.
const graphOf = (
  env: SchemaCompareEnv,
  objects: SchemaObjects,
  signal: AbortSignal,
): Promise<DependencyGraph | undefined> =>
  scriptGraph(graphObjects(objects), env.parser, {
    signal,
    logger: env.logger,
    failure: 'Reading which views and macros use which failed; the script orders them by name.',
  });

async function schemaUpdate(
  env: SchemaCompareEnv,
  { left, right }: SchemaPair,
  comparison: SchemaComparison,
  signal: AbortSignal,
): Promise<string> {
  // The source is read again only for the tables that only it has; the rest of the script needs no connection.
  const parts = await readScriptParts(
    () => readSide(env, left, left.objects.schema),
    { left: left.objects, right: right.objects },
    comparison,
    (objects) => graphOf(env, objects, signal),
    signal,
  );
  return schemaScript({ source: left, target: right, comparison, ...parts }, tokenizer(env));
}

// The file name of the report in the preview; catalog names keep only letters, digits, dots, dashes and underscores.
function reportFileName(...sides: readonly { connectionName: string; schemaName: string }[]): string {
  const part = ({ connectionName, schemaName }: { connectionName: string; schemaName: string }): string =>
    `${connectionName}.${schemaName}`.replace(/[^\w.-]+/g, '_').slice(0, 60);
  return `Schema Compare ${sides.map(part).join(' vs ')}.md`;
}

async function compareSchemasOf(env: SchemaCompareEnv, source: Picked, target: Picked): Promise<void> {
  if (!('schema' in source) || !('schema' in target))
    throw new Error('Schema Compare of two schemas got a table.');
  const read = await cancellable('Comparing the schemas...', (signal) =>
    readSchemas(readSide(env, source.side, source.schema), readSide(env, target.side, target.schema), signal),
  );
  let pair: SchemaPair = {
    left: { ...source.side, schemaName: source.schema.name, objects: read.left },
    right: { ...target.side, schemaName: target.schema.name, objects: read.right },
    compared: read.compared,
    omitted: read.omitted,
  };
  for (;;) {
    const comparison = compareSchemas(pair.left.objects, pair.right.objects, pair.compared, pair.omitted);
    await env.schemaDocuments.preview(
      reportFileName(pair.left, pair.right),
      schemaReport(pair.left, pair.right, comparison),
    );
    const choice = await choose(schemaSummary(comparison), differs(comparison));
    if (choice === SWAP) {
      pair = { ...pair, ...swapped(pair), compared: pair.compared.map(swapped) };
      continue;
    }
    if (choice === SCRIPT) {
      const current = pair;
      const text = await cancellable('Writing the script...', (signal) =>
        schemaUpdate(env, current, comparison, signal),
      );
      await env.openSql(current.right.connectionId, text);
    }
    return;
  }
}

async function run(env: SchemaCompareEnv): Promise<void> {
  const sides = connected(env);
  if (sides.length === 0) {
    showConnectFirst(GOAL);
    return;
  }
  const mode = await pickOne(MODES, { title: 'Schema Compare', placeholder: 'What to compare' });
  if (!mode) return;
  const rows = await cancellable('Reading the catalogs...', () => sideItems(env, mode.value, sides));
  const what = mode.value === 'tables' ? 'table' : 'schema';
  if (rows.length < 2) {
    void vscode.window.showInformationMessage(
      `There are fewer than two ${what}s in the connected catalogs to compare. Connect another catalog to compare across connections.`,
    );
    return;
  }
  const source = await pickOne(rows, {
    title: 'Schema Compare: source (left side)',
    placeholder: `The ${what} that the script takes as the model`,
  });
  if (!source) return;
  const target = await pickOne(
    rows.filter((row) => row !== source),
    { title: 'Schema Compare: target (right side)', placeholder: `The ${what} that the script changes` },
  );
  if (!target) return;
  await (mode.value === 'tables'
    ? compareTables(env, source.value, target.value)
    : compareSchemasOf(env, source.value, target.value));
}

/** Schema Compare: two tables or two schemas of the connected catalogs, what differs, and a script that aligns them. */
export function registerSchemaCompare(env: SchemaCompareEnv): vscode.Disposable[] {
  return [env.register(COMMAND, () => run(env))];
}
