import * as vscode from 'vscode';
import { catalogAt } from '../actions';
import type { SnapshotId } from '../catalog/model';
import type { Tokenize } from '../ddl-script/check';
import { readCreatedTable } from '../ddl-script/read';
import { askSavePath } from '../export/save.vscode';
import { formatBytes, groupedPlural } from '../shell/numbers';
import type { CatalogTree } from '../tree/model';
import type { NodeRef } from '../tree/refs';
import type { DataActions } from './commands.vscode';
import { scriptInsertWithData } from './insert-data';
import type { DataTarget } from './resolve';

interface InsertDataCommandEnv {
  readonly actions: Pick<DataActions, 'read' | 'openSql'>;
  readonly tree: Pick<CatalogTree, 'reader' | 'state'>;
  readonly tokenize: Tokenize;
}

/**
 * Script as INSERT with Data... on a table or view node: the script opens as a new SQL document bound to the
 * connection, or, when the user chooses so for a large one, goes to a .sql file. A table gets the CREATE TABLE of
 * Script as CREATE from the catalog at the snapshot that the tree shows.
 */
export async function scriptInsertData(
  env: InsertDataCommandEnv,
  ref: NodeRef,
  target: DataTarget,
  snapshot: SnapshotId | undefined,
): Promise<void> {
  const { table, connectionId } = target.relation;
  const name = `${table.schema}.${table.table}`;
  await scriptInsertWithData(
    {
      read: (at, title, read) => env.actions.read(target, at, title, read),
      tokenize: env.tokenize,
      ...(ref.kind === 'table'
        ? {
            table: () => {
              const { reader, snapshot: shown } = catalogAt(
                env.tree,
                connectionId,
                'script the INSERT with Data',
              );
              const head = {
                id: ref.table.id,
                schemaName: ref.schema.name,
                name: ref.table.name,
                comment: ref.table.comment,
              };
              return readCreatedTable(reader, shown, head, reader.metadata());
            },
          }
        : {}),
      ask: async ({ rows, bytes }) => {
        const answer = await vscode.window.showWarningMessage(
          `"${name}" has ${groupedPlural(rows, 'row')}; its script would be about ${formatBytes(bytes)}.`,
          {
            modal: true,
            detail:
              'Create opens it in a new SQL document, which can be slow for a large script. Save as File writes it to a .sql file instead.',
          },
          'Create',
          'Save as File...',
        );
        return answer === 'Create' ? 'create' : answer === 'Save as File...' ? 'save' : undefined;
      },
      savePath: () =>
        askSavePath({
          title: `Save the INSERT script of ${name}`,
          stem: name,
          extension: 'sql',
          filters: { SQL: ['sql'] },
        }),
      open: (text) => env.actions.openSql(connectionId, text),
      info: (message) => void vscode.window.showInformationMessage(message),
    },
    table,
    snapshot,
  );
}
