import { macroNodeKind } from './graph';
import * as vscode from 'vscode';
import { shownSnapshot } from '../actions';
import { showConnectFirst } from '../command.vscode';
import type { Register } from '../command.vscode';
import { openReport } from '../shell/host.vscode';
import { LAKE_SCOPE, scopeKey, scopeOfNode, scopeSuffix } from '../shell/scope';
import type { ReportScope } from '../shell/scope';
import type { ReportHostEnv } from '../shell/host.vscode';
import type { StatisticsTarget } from '../stats/target';
import type { NodeRef, TreeNode } from '../tree/refs';
import { planDependenciesAction } from './actions';
import { performDependenciesAction } from './execute';
import type { NodeKind } from './graph';
import { dependenciesKind } from './kind';
import { nameAt } from './model';
import type { SqlParser } from './parser';
import { lakeData, objectData, readGraph, schemaData } from './read';

interface DependenciesCommandEnv extends ReportHostEnv {
  readonly view: Pick<vscode.TreeView<TreeNode>, 'reveal'>;
  readonly showStatistics: (target: StatisticsTarget, snapshot: number) => Promise<void>;
  readonly register: Register;
  /** Parses the SQL of views and macros; it runs nothing. */
  readonly parser: SqlParser;
}

/** What one panel shows: an object, or the lake or a schema; `at` is a snapshot other than the tree's. */
interface DependenciesParams {
  readonly object?: { readonly kind: NodeKind; readonly id: number };
  readonly scope: ReportScope;
  readonly at?: number;
}

const COMMAND = 'aantje.showDependencies';
const GOAL = 'show its dependencies';

// The object a tree node stands for; undefined when it has no dependencies report.
function objectOf(ref: NodeRef): { readonly kind: NodeKind; readonly id: number } | undefined {
  switch (ref.kind) {
    case 'table':
      return { kind: 'table', id: ref.table.id };
    case 'view':
      return { kind: 'view', id: ref.view.id };
    case 'macro':
      return { kind: macroNodeKind(ref.macro), id: ref.macro.id };
    default:
      return undefined;
  }
}

/** Show Dependencies: what uses an object and what it uses, or the whole lake; one panel per object. */
export function registerDependenciesCommand(env: DependenciesCommandEnv): vscode.Disposable[] {
  const { tree, store, parser } = env;

  const report = openReport(env, {
    command: COMMAND,
    kind: dependenciesKind,
    noun: 'dependencies report',
    goal: GOAL,
    keyOf: (profile, { object, scope }: DependenciesParams) =>
      object ? JSON.stringify([profile.id, object.kind, object.id]) : scopeKey(profile.id, scope),
    open: (reader, profile, { object, scope, at }) => {
      // At the given snapshot, or at the one the tree shows.
      const snapshot = at ?? shownSnapshot(tree.state(profile.id));
      if (snapshot === undefined) return undefined;
      return {
        progress: `Reading the dependencies of "${profile.name}"...`,
        read: async (signal) => {
          const graph = await readGraph(reader, parser, snapshot, signal);
          return (
            (object
              ? objectData(graph, profile.name, snapshot, object)
              : scope.kind === 'schema'
                ? schemaData(graph, profile.name, snapshot, scope)
                : lakeData(graph, profile.name, snapshot)) ?? null
          );
        },
        title: (data) =>
          data.target === null
            ? `Dependencies · ${profile.name}${scopeSuffix(scope)}`
            : `Dependencies of ${nameAt(data, data.target)} · ${profile.name}`,
        absent:
          'This object does not exist at the snapshot that the tree shows, so it has no dependencies to show.',
      };
    },
    // A Refresh reads at the snapshot that the tree shows now.
    refreshParams: ({ object, scope }) => ({ scope, ...(object ? { object } : {}) }),
    planAction: planDependenciesAction,
    perform: (plan, profile, data): Promise<void> =>
      performDependenciesAction(plan, data.snapshot, {
        connectionId: profile.id,
        tree,
        reveal: async (node) => {
          await env.view.reveal(node, { select: true, focus: true });
        },
        showStatistics: env.showStatistics,
        showDependencies: (node, snapshot): Promise<void> =>
          report.show(profile, { object: { kind: node.kind, id: node.id }, scope: LAKE_SCOPE, at: snapshot }),
        info: (text) => void vscode.window.showInformationMessage(text),
      }),
  });

  return [
    { dispose: () => report.dispose() },
    env.register(COMMAND, async (node) => {
      const ref = node?.ref;
      const profile = ref && store.get(ref.connectionId);
      if (!ref || !profile) {
        showConnectFirst(GOAL);
        return;
      }
      const scope = scopeOfNode(ref);
      if (scope) {
        await report.show(profile, { scope });
        return;
      }
      const object = objectOf(ref);
      if (object) {
        await report.show(profile, { object, scope: LAKE_SCOPE });
      }
    }),
  ];
}
