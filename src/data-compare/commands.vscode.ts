import * as vscode from 'vscode';
import { catalogAt } from '../actions';
import { foldIdentifier } from '../catalog/ddl';
import { showConnectFirst } from '../command.vscode';
import type { Register } from '../command.vscode';
import { globalValue } from '../catalog/model';
import type { CatalogReader } from '../catalog/model';
import type { ConnectionProfile } from '../connections/profile';
import type { DataActions } from '../data/commands.vscode';
import { pickMany, pickOne } from '../pick.vscode';
import { cancellable } from '../progress.vscode';
import { tableItems } from '../schema-compare/picks';
import type { Picked } from '../schema-compare/picks';
import type { Side } from '../schema-compare/tables';
import type { CatalogTree } from '../tree/model';
import { CompareKeys } from './keys';
import type { KeyStore } from './keys';
import {
  differences,
  keyText,
  leftOutText,
  matchColumns,
  pairingNote,
  proposedKey,
  repeatedKeyText,
  sideText,
  countsText,
} from './model';
import type { ColumnMatch, CompareCounts, CompareSide } from './model';
import { compareTables } from './read';
import type { ReadSide } from './read';
import { updateScript } from './script';

export interface DataCompareEnv {
  readonly tree: Pick<CatalogTree, 'state' | 'reader'>;
  readonly store: { get(id: string): ConnectionProfile | undefined };
  readonly actions: Pick<DataActions, 'openSql' | 'showGrid' | 'accessOf'>;
  readonly keys: KeyStore;
  readonly register: Register;
}

const COMMAND = 'aantje.dataCompare';
const GOAL = 'compare the rows of two tables';
const SCRIPT = 'Script as Update';
const SWAP = 'Swap Sides';
const WHOLE_ROWS = 'Compare Whole Rows';
/** The alias of a source of another connection in the session of the script's document. */
const SOURCE_ALIAS = 'source_lake';

/** A table that was picked, with the reader of its catalog at the snapshot its tree shows. */
interface PickedTable {
  readonly side: Side;
  readonly table: { readonly id: number; readonly schemaName: string; readonly name: string };
  readonly reader: CatalogReader;
}

const compareSide = ({ side, table }: PickedTable): CompareSide => ({
  connectionId: side.connectionId,
  connectionName: side.connectionName,
  schema: table.schemaName,
  table: table.name,
  snapshot: side.snapshot,
});

async function readSide(env: DataCompareEnv, picked: PickedTable): Promise<ReadSide> {
  const profile = env.store.get(picked.side.connectionId);
  if (!profile) {
    throw new Error(`The connection "${picked.side.connectionName}" was removed.`);
  }
  const [access, metadata] = await Promise.all([
    env.actions.accessOf(profile, picked.side.snapshot),
    picked.reader.metadata(),
  ]);
  return { ...compareSide(picked), access, dataPath: globalValue(metadata, 'data_path') };
}

const pickedTable = (env: DataCompareEnv, picked: Picked): PickedTable => {
  if (!('table' in picked)) throw new Error('Data Compare got a schema.');
  const { reader } = catalogAt(env.tree, picked.side.connectionId, GOAL, picked.side.connectionName);
  return { side: picked.side, table: picked.table, reader };
};

async function columnsOf(left: PickedTable, right: PickedTable): Promise<ColumnMatch> {
  const [source, target] = await Promise.all([
    left.reader.columns(left.table.id, left.side.snapshot),
    right.reader.columns(right.table.id, right.side.snapshot),
  ]);
  return matchColumns(source, target);
}

/** The key columns: those of both tables, the remembered or proposed ones selected; undefined when cancelled. */
async function pickKey(
  match: ColumnMatch,
  remembered: readonly string[] | undefined,
): Promise<string[] | undefined> {
  const proposed = new Set(proposedKey(match.matched, remembered));
  const chosen = await pickMany(
    match.matched.map((column) => ({
      label: column.source,
      description:
        column.sourceType === column.targetType
          ? column.sourceType
          : `${column.sourceType} · target ${column.targetType}`,
      picked: proposed.has(column.source),
    })),
    {
      title: 'Data Compare: key columns',
      placeholder: 'The columns that identify a row in both tables; none compares whole rows',
    },
  );
  return chosen?.map((item) => item.label);
}

function comparedText(
  source: CompareSide,
  target: CompareSide,
  counts: CompareCounts,
  key: readonly string[],
  leftOut: string,
): string {
  const which = `"${sideText(source)}" and "${sideText(target)}"`;
  const verdict =
    differences(counts) === 0
      ? `${which} have the same rows: ${counts.equal} equal`
      : `${which} differ: ${countsText(counts, key.length > 0)}`;
  const note = pairingNote(counts, key);
  return `${verdict} (${keyText(key)}).${leftOut === '' ? '' : ` Not compared: ${leftOut}.`}${note === '' ? '' : ` ${note}`}`;
}

/** Compares, shows the grid and the message, and runs what the user chooses; Swap Sides compares the other way round. */
async function compare(
  env: DataCompareEnv,
  first: PickedTable,
  second: PickedTable,
  chosenKey: string[],
): Promise<void> {
  let [left, right] = [first, second];
  let key = chosenKey;
  for (;;) {
    const [source, target, match] = await cancellable('Reading the tables...', () =>
      Promise.all([readSide(env, left), readSide(env, right), columnsOf(left, right)]),
    );
    // After Swap Sides the key names the columns of the new source.
    key = key.map(
      (name) =>
        match.matched.find((column) => foldIdentifier(column.target) === foldIdentifier(name))?.source ??
        match.matched.find((column) => foldIdentifier(column.source) === foldIdentifier(name))?.source ??
        name,
    );
    const outcome = await cancellable('Comparing the rows...', (signal) =>
      compareTables(source, target, match, key, signal),
    );
    if (outcome.kind === 'duplicate-keys') {
      const choice = await vscode.window.showWarningMessage(
        repeatedKeyText(key, outcome.source, outcome.target),
        WHOLE_ROWS,
      );
      if (choice !== WHOLE_ROWS) return;
      key = [];
      continue;
    }
    if (outcome.kind === 'key-not-cast') {
      void vscode.window.showWarningMessage(
        `The key column ${outcome.columns.map((c) => JSON.stringify(c.source)).join(', ')} of the target has values that do not cast to the type of the source. Choose another key.`,
      );
      return;
    }
    env.actions.showGrid(gridKey(source, target, key), gridTitle(source, target), outcome.data);
    const text = comparedText(source, target, outcome.counts, key, leftOutText(outcome.plan));
    if (differences(outcome.counts) === 0) {
      void vscode.window.showInformationMessage(text);
      return;
    }
    const choice = await vscode.window.showInformationMessage(text, SCRIPT, SWAP);
    if (choice === SWAP) {
      [left, right] = [right, left];
      continue;
    }
    if (choice === SCRIPT) {
      const other = source.connectionId !== target.connectionId;
      const script = updateScript({
        source,
        target,
        plan: outcome.plan,
        key,
        counts: outcome.counts,
        sourceAlias: other ? SOURCE_ALIAS : undefined,
      });
      await env.actions.openSql(
        target.connectionId,
        script,
        other
          ? { connectionId: source.connectionId, alias: SOURCE_ALIAS, dataPath: source.dataPath }
          : undefined,
      );
    }
    return;
  }
}

const gridKey = (source: CompareSide, target: CompareSide, key: readonly string[]): string =>
  JSON.stringify(['data-compare', source, target, key]);

const gridTitle = (source: CompareSide, target: CompareSide): string =>
  `${sideText(source)} ↔ ${sideText(target)}`;

async function run(env: DataCompareEnv, sides: readonly Side[]): Promise<void> {
  if (sides.length === 0) {
    showConnectFirst(GOAL);
    return;
  }
  const rows = await cancellable('Reading the catalogs...', async () =>
    (
      await Promise.all(
        sides.map(async (side) =>
          tableItems(
            side,
            await catalogAt(env.tree, side.connectionId, GOAL, side.connectionName).reader.entries(
              side.snapshot,
            ),
          ),
        ),
      )
    ).flat(),
  );
  if (rows.length < 2) {
    void vscode.window.showInformationMessage(
      'There are fewer than two tables in the connected catalogs to compare. Connect another catalog to compare across connections.',
    );
    return;
  }
  const source = await pickOne(rows, {
    title: 'Data Compare: source (left side)',
    placeholder: 'The table whose rows the script takes as the model',
  });
  if (!source) return;
  const target = await pickOne(
    rows.filter((row) => row !== source),
    { title: 'Data Compare: target (right side)', placeholder: 'The table whose rows the script changes' },
  );
  if (!target) return;
  const left = pickedTable(env, source.value);
  const right = pickedTable(env, target.value);
  const match = await cancellable('Reading the columns...', () => columnsOf(left, right));
  if (match.matched.length === 0) {
    void vscode.window.showInformationMessage('The two tables have no column in common to compare.');
    return;
  }
  const memory = new CompareKeys(env.keys);
  const key = await pickKey(match, memory.remembered(compareSide(left), compareSide(right)));
  if (key === undefined) return;
  await memory.remember(compareSide(left), compareSide(right), key);
  await compare(env, left, right, key);
}

/** Data Compare: the rows of two tables of the connected catalogs, what differs, and a script that aligns them. */
export function registerDataCompare(env: DataCompareEnv, sides: () => readonly Side[]): vscode.Disposable[] {
  return [env.register(COMMAND, () => run(env, sides()))];
}
