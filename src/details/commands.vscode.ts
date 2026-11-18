import * as vscode from 'vscode';
import { findEntryNode, shownSnapshot } from '../actions';
import type { ActiveConnection } from '../active-connection.vscode';
import { showConnectFirst } from '../command.vscode';
import type { Register } from '../command.vscode';
import { findNode } from '../dependencies/execute';
import type { SqlParser } from '../dependencies/parser';
import { readGraph } from '../dependencies/read';
import { openReport } from '../shell/host.vscode';
import type { ReportHostEnv } from '../shell/host.vscode';
import { reportHeading } from '../shell/report-heading';
import { LAKE_SCOPE, scopeKey, scopeSchema } from '../shell/scope';
import type { ReportScope } from '../shell/scope';
import { openTableScript, tableStatisticsTarget } from '../shell/table-actions.vscode';
import type { TableActionEnv } from '../shell/table-actions.vscode';
import type { NodeRef, TreeNode } from '../tree/refs';
import { planDetailsAction } from './actions';
import type { DetailsPlan } from './actions';
import { detailsKind } from './kind';
import { detailsTsv } from './markdown';
import type { DetailsData } from './model';
import { readDetails } from './read';

const COMMAND = 'aantje.showDetails';
const GOAL = 'show its details';

interface DetailsEnv extends ReportHostEnv, TableActionEnv {
  readonly active: Pick<ActiveConnection, 'select' | 'current'>;
  readonly view: Pick<vscode.TreeView<TreeNode>, 'reveal' | 'selection'>;
  readonly register: Register;
  /** Parses the SQL of views and macros for their dependencies; it runs nothing. */
  readonly parser: SqlParser;
}

/** The scope of a node: a connection the lake, a schema or anything below it its schema. */
export function detailsScopeOf(ref: NodeRef): ReportScope {
  return 'schema' in ref ? { kind: 'schema', id: ref.schema.id, name: ref.schema.name } : LAKE_SCOPE;
}

// The command of the tree that a row action runs on the node of its object.
const NODE_COMMANDS = {
  preview: 'aantje.previewTable',
  showSchemaHistory: 'aantje.showSchemaHistory',
  showDependencies: 'aantje.showDependencies',
} as const;

const SCRIPTS = { scriptMerge: 'merge', scriptRewrite: 'rewrite', scriptFlush: 'flush' } as const;

async function perform(
  env: DetailsEnv,
  connectionId: string,
  plan: DetailsPlan,
  data: DetailsData,
): Promise<void> {
  if (plan.action === 'copy') {
    await vscode.env.clipboard.writeText(detailsTsv(data, plan.view));
    vscode.window.setStatusBarMessage('Copied the details', 3000);
    return;
  }
  const { row, kind } = plan;
  const table = { id: row.id, schemaId: row.schemaId, schema: row.schema, name: row.name };
  switch (plan.action) {
    case 'showStatistics':
      await env.showStatistics(tableStatisticsTarget(connectionId, table), data.snapshot);
      return;
    case 'scriptMerge':
    case 'scriptRewrite':
    case 'scriptFlush': {
      const figures = 'files' in row ? { rows: row.rows, files: row.files, sizeBytes: row.sizeBytes } : {};
      await openTableScript(env, connectionId, {
        kind: SCRIPTS[plan.action],
        table: { ...table, ...figures },
      });
      return;
    }
    default:
      break;
  }
  const node =
    kind === 'macro'
      ? await findNode(env.tree, connectionId, {
          ...table,
          kind: row.kind === 'table' ? 'tableMacro' : 'scalarMacro',
        })
      : await findEntryNode(env.tree, connectionId, { kind, ...table, schemaName: row.schema });
  if (!node) {
    void vscode.window.showInformationMessage(
      `The tree does not show "${row.schema}.${row.name}". It may not exist at the snapshot that the tree shows, or a filter of the tree hides it.`,
    );
  } else if (plan.action === 'showInTree') {
    await env.view.reveal(node, { select: true, focus: true });
  } else {
    await vscode.commands.executeCommand(NODE_COMMANDS[plan.action], node);
  }
}

/**
 * Show Details: the tables, views and macros of the lake or a schema in one sortable list, as Object Explorer Details
 * in SSMS. On a node it shows the details of the node's schema, or of the lake for a connection; without a node, of
 * the selected node of the tree, or of the active connection.
 */
export function registerDetailsCommand(env: DetailsEnv): vscode.Disposable[] {
  const { tree, store, parser } = env;
  const report = openReport(env, {
    command: COMMAND,
    kind: detailsKind,
    noun: 'details report',
    goal: GOAL,
    keyOf: (profile, { scope }: { readonly scope: ReportScope }) => scopeKey(profile.id, scope),
    open: (reader, profile, { scope }) => {
      const state = tree.state(profile.id);
      const snapshot = shownSnapshot(state);
      return snapshot === undefined
        ? undefined
        : {
            progress: `Reading the details of "${profile.name}"...`,
            read: (signal) =>
              readDetails(
                reader,
                {
                  connection: profile.name,
                  snapshot,
                  scope,
                  latest: state.snapshot === 'latest',
                  now: new Date(),
                  graph: (outer) => readGraph(reader, parser, snapshot, outer),
                },
                signal,
              ),
            title: () => `${reportHeading('Details', scopeSchema(scope))} · ${profile.name}`,
          };
    },
    planAction: planDetailsAction,
    perform: (plan, profile, data) => perform(env, profile.id, plan, data),
  });

  return [
    { dispose: () => report.dispose() },
    env.register(COMMAND, async (node) => {
      const target = node ?? env.view.selection[0];
      const profile = target ? store.get(target.ref.connectionId) : env.active.current();
      if (!profile) {
        showConnectFirst(GOAL);
        return;
      }
      await report.show(profile, { scope: target ? detailsScopeOf(target.ref) : LAKE_SCOPE });
    }),
  ];
}
