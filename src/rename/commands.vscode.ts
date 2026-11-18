import * as vscode from 'vscode';
import type { Register } from '../command.vscode';
import { buildGraph } from '../dependencies/graph';
import type { CatalogObjects, DependencyNode } from '../dependencies/graph';
import type { SqlParser, SqlTokenizer } from '../dependencies/parser';
import { readObjects } from '../dependencies/read';
import type { IcebergCopies } from '../iceberg/records';
import type { IcebergTargetStore } from '../iceberg/store';
import { connectionClosed } from '../messages';
import { cancellable } from '../progress.vscode';
import type { CatalogTree } from '../tree/model';
import type { NodeRef } from '../tree/refs';
import { planRename } from './plan';
import type { RenameTarget } from './plan';
import { renameScript } from './script';
import type { Renamed } from './script';
import { icebergSyncs, nameProblem, takenNames, whatToRename } from './target';
import type { Wanted } from './target';

export interface RenameEnv {
  readonly tree: Pick<CatalogTree, 'state' | 'reader'>;
  /** Opens the text in a new SQL document bound to the connection, and runs nothing. */
  readonly openSql: (connectionId: string, text: string) => Promise<void>;
  readonly register: Register;
  /** Parses and tokenizes the SQL of views and macros; it runs nothing. */
  readonly parser: SqlParser & SqlTokenizer;
  /** The syncs to Iceberg, which the script of a synced table speaks of. */
  readonly iceberg?: {
    readonly copies: Pick<IcebergCopies, 'list'>;
    readonly targets: Pick<IcebergTargetStore, 'list'>;
  };
}

const COMMAND = 'aantje.renameObject';

// The renamed object in the graph of the newest snapshot, by its id; undefined when that snapshot lacks it.
function targetIn(
  objects: CatalogObjects,
  nodes: readonly DependencyNode[],
  wanted: Wanted,
): { readonly target: RenameTarget; readonly renamed: Renamed } | undefined {
  const kind = wanted.kind === 'view' ? 'view' : 'table';
  const node = nodes.findIndex((candidate) => candidate.kind === kind && candidate.id === wanted.id);
  const found = nodes[node];
  if (!found) return undefined;
  if (wanted.kind !== 'column') {
    return {
      target: { kind: wanted.kind, node },
      renamed: { kind: wanted.kind, schema: found.schema, name: found.name },
    };
  }
  const column = objects.columns?.get(wanted.id)?.find((name) => name === wanted.column);
  return column === undefined
    ? undefined
    : {
        target: { kind: 'column', node, column },
        renamed: { kind: 'column', schema: found.schema, name: found.name, column },
      };
}

async function rename(env: RenameEnv, ref: NodeRef | undefined): Promise<void> {
  const wanted = ref && whatToRename(ref);
  if (!ref || !wanted) return;
  if (typeof wanted === 'string') {
    void vscode.window.showInformationMessage(wanted);
    return;
  }
  const { connectionId } = ref;
  const reader = env.tree.reader(connectionId);
  const state = env.tree.state(connectionId);
  const newest = state.latestSnapshot;
  if (!reader || newest === undefined) throw connectionClosed('script the rename');
  // A rename acts on the newest state: the names it may not take, and the script, are those of the newest snapshot.
  const taken = await takenNames(reader, newest, wanted);
  const name = await vscode.window.showInputBox({
    title: `Rename the ${wanted.label}`,
    prompt:
      'The new name. aantje writes a script with the rename and the views and macros that name it; nothing runs.',
    value: wanted.old,
    validateInput: (value) => nameProblem(value, wanted.old, taken, wanted.kind),
  });
  if (name === undefined) return;
  const script = await cancellable('Writing the rename script...', async (signal) => {
    const objects = await readObjects(reader, newest, signal, { columns: true });
    const graph = await buildGraph(objects, env.parser, { signal, limit: Number.POSITIVE_INFINITY });
    const found = targetIn(objects, graph.nodes, wanted);
    if (!found) return undefined;
    signal.throwIfAborted();
    const plan = await planRename({ objects, graph, target: found.target, name }, env.parser);
    const syncs =
      found.renamed.kind === 'view' || !env.iceberg
        ? []
        : icebergSyncs(env.iceberg, connectionId, wanted.id, found.renamed);
    const pinned = state.snapshot === 'latest' || state.snapshot === newest ? undefined : state.snapshot;
    return renameScript(
      { renamed: found.renamed, name, snapshot: newest, pinned, plan, nodes: graph.nodes, syncs },
      (text) => env.parser.tokenize(text),
    );
  });
  if (script === undefined) {
    void vscode.window.showInformationMessage(
      `The ${wanted.label} is not in the newest snapshot (@${newest}). Refresh the tree and try again.`,
    );
    return;
  }
  await env.openSql(connectionId, script);
}

/** Rename...: a script that renames a table, a view or a column of a table with the views and macros that name it. */
export function registerRenameCommands(env: RenameEnv): vscode.Disposable[] {
  return [env.register(COMMAND, (node) => rename(env, node?.ref))];
}
