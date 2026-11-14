import type * as vscode from 'vscode';
import type { Register } from './command.vscode';
import { maintenanceScript } from './maintenance/scripts';
import type { MaintenanceKind } from './maintenance/scripts';
import { scriptOf } from './script-templates';
import type { ScriptVerb } from './script-templates';
import type { CatalogTree } from './tree/model';
import type { NodeRef } from './tree/refs';

interface ScriptCommandEnv {
  readonly tree: CatalogTree;
  readonly register: Register;
  /** Opens the text in a new SQL editor bound to the connection; it never runs it. */
  readonly openSql: (connectionId: string, text: string) => Promise<void>;
}

const maintenance: readonly (readonly [string, MaintenanceKind])[] = [
  ['aantje.maintenanceCheckpoint', 'checkpoint'],
  ['aantje.maintenanceMerge', 'merge'],
  ['aantje.maintenanceRewrite', 'rewrite'],
  ['aantje.maintenanceFlush', 'flush'],
  ['aantje.maintenanceExpire', 'expire'],
  ['aantje.maintenanceCleanup', 'cleanup'],
  ['aantje.maintenanceOrphans', 'orphans'],
  ['aantje.maintenanceOption', 'option'],
];

// Script as and Maintenance commands; the generator gives undefined for a node without such a script.
const scripts: readonly (readonly [
  string,
  (tree: CatalogTree, ref: NodeRef) => Promise<string | undefined> | string | undefined,
])[] = [
  ...(
    [
      ['aantje.scriptCreate', 'create'],
      ['aantje.scriptSelect', 'select'],
      ['aantje.scriptInsert', 'insert'],
      ['aantje.scriptAlter', 'alter'],
      ['aantje.scriptDrop', 'drop'],
    ] as const satisfies readonly (readonly [string, ScriptVerb])[]
  ).map(([id, verb]) => [id, (tree: CatalogTree, ref: NodeRef) => scriptOf(verb, tree, ref)] as const),
  ...maintenance.map(
    ([id, kind]) => [id, (tree: CatalogTree, ref: NodeRef) => maintenanceScript(tree, kind, ref)] as const,
  ),
];

/** Script as and Maintenance on a node of the explorer: the script opens bound to the node's connection, so F5 runs it there. */
export function registerScriptCommands({ tree, register, openSql }: ScriptCommandEnv): vscode.Disposable[] {
  return scripts.map(([id, scriptFor]) =>
    register(id, async (node) => {
      const text = node && (await scriptFor(tree, node.ref));
      if (node && text !== undefined) await openSql(node.ref.connectionId, text);
    }),
  );
}
