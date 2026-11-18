import * as vscode from 'vscode';
import { catalogAt } from '../actions';
import { showConnectFirst } from '../command.vscode';
import type { StoredFile } from '../catalog/model';
import type { DataAccessFactory } from '../data/resolve';
import { fileTypeOf } from '../files/kinds';
import { pickerLabel } from '../messages';
import { withCancel } from '../progress.vscode';
import { openReport } from '../shell/host.vscode';
import { count } from '../shell/model';
import type { ReportCommandEnv } from '../shell/report-port.vscode';
import { planParquetAction } from './actions';
import { parquetKind } from './kind';
import { FILE_GROUP_LABEL, fileFacts, fileGroups, fileName, parquetHeading } from './model';
import type { FileChoice } from './model';
import { inspectFile, lakeTarget, tableFiles } from './read';
import type { InspectParams } from './read';

const FILE_COMMAND = 'aantje.inspectParquetFile';
const TABLE_COMMAND = 'aantje.inspectDataFiles';
const GOAL = 'inspect its Parquet files';
/** The files of each group of the pick: the largest, the newest, the smallest. */
const PER_GROUP = 10;

interface ParquetEnv extends ReportCommandEnv {
  readonly dataAccess: DataAccessFactory;
}

type FileItem = vscode.QuickPickItem & { readonly choice?: FileChoice };

/** The files of the pick, which the drop-down of the panel offers too: the largest, the newest, the smallest. */
function fileChoices(
  files: readonly StoredFile[],
  table: { readonly id: number; readonly name: string },
  snapshot: number,
  dataPath: string | null,
): FileChoice[] {
  return fileGroups(files, PER_GROUP).flatMap(({ group, files: members }) =>
    members.map((file) => ({ group, target: lakeTarget(file, table, snapshot, dataPath) })),
  );
}

function fileItems(choices: readonly FileChoice[]): FileItem[] {
  return choices.flatMap((choice, index): FileItem[] => [
    ...(choices[index - 1]?.group === choice.group
      ? []
      : [{ label: FILE_GROUP_LABEL[choice.group], kind: vscode.QuickPickItemKind.Separator }]),
    {
      label: pickerLabel(fileName(choice.target.path)),
      description: choice.target.lake ? fileFacts(choice.target.lake) : '',
      detail: pickerLabel(choice.target.path),
      choice,
    },
  ]);
}

/**
 * Inspect Parquet File on a file of the Files folder, one panel per file; Inspect Data Files... on a table, one panel per
 * table, whose drop-down switches between the data files of the pick.
 */
export function registerParquetInspector(env: ParquetEnv): vscode.Disposable[] {
  const { tree, store } = env;

  const report = openReport(env, {
    command: FILE_COMMAND,
    kind: parquetKind,
    noun: 'Parquet inspector',
    goal: GOAL,
    keyOf: (profile, { target }: InspectParams) =>
      JSON.stringify(target.lake ? [profile.id, 'table', target.lake.tableId] : [profile.id, target.path]),
    open: (reader, profile, params) => ({
      progress: `Reading the footer of "${fileName(params.target.path)}"...`,
      read: async (signal) =>
        inspectFile(reader, await env.dataAccess(profile, undefined), profile.name, params, signal),
      title: (data) => `${parquetHeading(data)} · ${profile.name}`,
    }),
    planAction: planParquetAction,
    perform: async (plan, profile, data) => {
      // The files of the drop-down stay with the panel: another file of them, a probe or a refresh keeps them.
      const files = data.files === undefined ? {} : { files: data.files };
      if (plan.action === 'open') {
        await report.show(profile, { target: plan.target, ...files });
        return;
      }
      if (plan.action === 'copy') {
        await vscode.env.clipboard.writeText(plan.markdown);
        vscode.window.setStatusBarMessage(`Copied the report of ${pickerLabel(data.name)}`, 3000);
        return;
      }
      const value = await vscode.window.showInputBox({
        title: `Probe the bloom filters of ${pickerLabel(plan.column.path)}`,
        prompt: 'The value to look for; DuckDB casts it to the type of the column.',
        ignoreFocusOut: true,
      });
      if (value !== undefined) {
        await report.show(profile, {
          target: data.target,
          ...files,
          probe: { column: plan.column.index, value },
        });
      }
    },
  });

  async function inspectTable(connectionId: string, table: { id: number; name: string }): Promise<void> {
    const profile = store.get(connectionId);
    if (!profile || !tree.reader(connectionId)) {
      showConnectFirst(GOAL);
      return;
    }
    const { reader, snapshot } = catalogAt(tree, connectionId, GOAL);
    const { files, dataPath, more } = await withCancel(
      `Reading the data files of ${table.name}...`,
      (signal) => tableFiles(reader, table.id, snapshot, signal),
    );
    if (files.length === 0) {
      void vscode.window.showInformationMessage(
        `${table.name} has no Parquet data file at snapshot ${snapshot}; its rows may be inlined in the catalog.`,
      );
      return;
    }
    const choices = fileChoices(files, table, snapshot, dataPath);
    const picked = await vscode.window.showQuickPick(fileItems(choices), {
      title: `Inspect a data file of ${pickerLabel(table.name)} @${snapshot}${more ? ' (the first files of the catalog)' : ''}`,
      placeHolder: `${count(files.length)} data files: pick one to inspect`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked?.choice) await report.show(profile, { target: picked.choice.target, files: choices });
  }

  return [
    { dispose: () => report.dispose() },
    report.command(env.register, (ref) =>
      ref.kind === 'file' && fileTypeOf(ref.entry.name)?.kind === 'parquet'
        ? { target: { path: ref.entry.path } }
        : undefined,
    ),
    env.register(TABLE_COMMAND, async (node) => {
      if (node?.ref.kind !== 'table') return;
      const { connectionId, schema, table } = node.ref;
      await inspectTable(connectionId, { id: table.id, name: `${schema.name}.${table.name}` });
    }),
  ];
}
