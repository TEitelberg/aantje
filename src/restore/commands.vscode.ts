import * as vscode from 'vscode';
import { catalogAt } from '../actions';
import type { Register } from '../command.vscode';
import type { Tokenize } from '../ddl-script/check';
import { commentName } from '../ddl-script/names';
import type { SqlTokenizer } from '../dependencies/parser';
import { pickOne } from '../pick.vscode';
import { cancellable } from '../progress.vscode';
import { pinnedOf } from '../script';
import { subjectLabel, subjectOf } from '../time-travel';
import type { CatalogTree } from '../tree/model';
import type { TreeNode } from '../tree/refs';
import { droppedItems, restoreDroppedScript } from './dropped';
import { readDroppedRestore, readTableRestore, restoreSnapshots } from './read';
import { restoreTableScript } from './table';

interface RestoreEnv {
  readonly tree: Pick<CatalogTree, 'state' | 'reader'>;
  /** Opens the text in a new SQL document bound to the connection, and runs nothing. */
  readonly openSql: (connectionId: string, text: string) => Promise<void>;
  readonly register: Register;
  /** Tokenizes the scripts that copy catalog text; it runs nothing. */
  readonly parser: SqlTokenizer;
}

const info = (message: string): void => {
  void vscode.window.showInformationMessage(message);
};

const WRITING = 'Writing the restore script...';

async function restoreTable(env: RestoreEnv, tokenize: Tokenize, node: TreeNode | undefined): Promise<void> {
  const subject = node && subjectOf(node.ref);
  if (!node || subject?.kind !== 'table') return;
  const { connectionId } = node.ref;
  const { reader, snapshot } = catalogAt(env.tree, connectionId, 'restore a table');
  const label = subjectLabel(subject);
  const rows = await restoreSnapshots(reader, subject, snapshot);
  if (rows.length === 0) {
    info(`"${label}" exists at no earlier snapshot that the catalog still has.`);
    return;
  }
  const chosen = await pickOne(rows, {
    title: `Restore ${label} to a snapshot`,
    placeholder: 'Choose the snapshot whose rows the table gets back',
    active: rows.filter((row) => row.picked),
  });
  if (!chosen) return;
  const pinned = pinnedOf(env.tree, connectionId);
  const text = await cancellable(WRITING, async () => {
    const input = await readTableRestore(reader, subject, chosen.snapshot, pinned);
    return input && (await restoreTableScript(input, tokenize));
  });
  if (text === undefined) {
    info(`"${label}" was dropped since: Restore Dropped Object... in the menu of its schema brings it back.`);
    return;
  }
  await env.openSql(connectionId, text);
}

async function restoreDropped(
  env: RestoreEnv,
  tokenize: Tokenize,
  node: TreeNode | undefined,
): Promise<void> {
  if (node?.ref.kind !== 'schema') return;
  const { connectionId, schema } = node.ref;
  const { reader } = catalogAt(env.tree, connectionId, 'restore a dropped object');
  const items = droppedItems(await reader.droppedObjects(schema.id));
  if (items.length === 0) {
    info(
      `No table, view or macro dropped from ${commentName(schema.name)} can be read at a snapshot that the catalog still has.`,
    );
    return;
  }
  const chosen = await pickOne(items, {
    title: `Restore a dropped object of ${commentName(schema.name)}`,
    placeholder: 'Choose the table, view or macro to bring back',
  });
  if (!chosen) return;
  const text = await cancellable(WRITING, async () =>
    restoreDroppedScript(await readDroppedRestore(reader, schema, chosen.value), tokenize),
  );
  await env.openSql(connectionId, text);
}

/** Restore Table to Snapshot and Restore Dropped Object: scripts that open unsaved, bound to the connection; nothing runs. */
export function registerRestoreCommands(env: RestoreEnv): vscode.Disposable[] {
  const tokenize: Tokenize = (text) => env.parser.tokenize(text);
  return [
    env.register('aantje.restoreTableToSnapshot', (node) => restoreTable(env, tokenize, node)),
    env.register('aantje.restoreDroppedObject', (node) => restoreDropped(env, tokenize, node)),
  ];
}
