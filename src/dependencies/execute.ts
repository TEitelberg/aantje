import { findEntryNode } from '../actions';
import type { CatalogReader, SnapshotId } from '../catalog/model';
import type { ScriptSource } from '../script';
import { scriptOf } from '../script-templates';
import type { StatisticsTarget } from '../stats/target';
import type { CatalogTree } from '../tree/model';
import type { NodeRef, TreeNode } from '../tree/refs';
import type { DependenciesPlan } from './actions';
import type { DependencyNode } from './graph';
import { nodeName } from './model';
import { connectionClosed } from '../messages';

/** What the actions of the report do in VS Code; the plan says what, the port does it. */
export interface DependenciesPort {
  readonly connectionId: string;
  readonly tree: Pick<CatalogTree, 'roots' | 'children' | 'reader' | 'state'>;
  reveal(node: TreeNode): Promise<void>;
  showStatistics(target: StatisticsTarget, snapshot: SnapshotId): Promise<void>;
  showDependencies(node: DependencyNode, snapshot: SnapshotId): Promise<void>;
  /** Opens the text in an untitled SQL document; nothing runs. */
  openSql(text: string): Promise<void>;
  info(message: string): void;
}

/** The tree node of an object in the folder of its kind; undefined when the tree does not show it. */
export async function findNode(
  tree: Pick<CatalogTree, 'roots' | 'children'>,
  connectionId: string,
  node: DependencyNode,
): Promise<TreeNode | undefined> {
  if (node.kind === 'table' || node.kind === 'view') {
    return findEntryNode(tree, connectionId, {
      kind: node.kind,
      id: node.id,
      name: node.name,
      schemaId: node.schemaId,
      schemaName: node.schema,
    });
  }
  const connection = tree.roots().find(({ ref }) => ref.connectionId === connectionId);
  const schema = (connection ? await tree.children(connection) : []).find(
    ({ ref }) => ref.kind === 'schema' && ref.schema.id === node.schemaId,
  );
  const folder = (schema ? await tree.children(schema) : []).find(
    ({ ref }) => ref.kind === 'folder' && ref.folder === 'macros',
  );
  return (folder ? await tree.children(folder) : []).find(
    ({ ref }) => ref.kind === 'macro' && ref.macro.id === node.id,
  );
}

// The tree as the scripts see it at the report's snapshot. They write columns at that snapshot and note that
// DROP and ALTER act on the newest state.
function shownAt(
  tree: DependenciesPort['tree'],
  snapshot: SnapshotId,
): Pick<CatalogTree, 'reader' | 'state'> & ScriptSource {
  return {
    fromReport: true,
    reader: (connectionId) => tree.reader(connectionId),
    state: (connectionId) => {
      const state = tree.state(connectionId);
      return { ...state, snapshot: snapshot === state.latestSnapshot ? 'latest' : snapshot };
    },
  };
}

// The payload the scripts are written for, read from the catalog as it was at the snapshot.
async function refOf(
  reader: CatalogReader,
  connectionId: string,
  snapshot: SnapshotId,
  node: DependencyNode,
): Promise<NodeRef | undefined> {
  const schema = (await reader.schemas(snapshot)).find(({ id }) => id === node.schemaId);
  if (!schema) {
    return undefined;
  }
  switch (node.kind) {
    case 'table': {
      const table = (await reader.tables(schema.id, snapshot)).find(({ id }) => id === node.id);
      return table && { kind: 'table', connectionId, schema, table };
    }
    case 'view': {
      const view = (await reader.views(schema.id, snapshot)).find(({ id }) => id === node.id);
      return view && { kind: 'view', connectionId, schema, view };
    }
    default: {
      const macro = (await reader.macros(schema.id, snapshot)).find(({ id }) => id === node.id);
      return macro && { kind: 'macro', connectionId, schema, macro };
    }
  }
}

/** Carries out a plan of the Dependencies report; scripts open in a SQL editor and never run. */
export async function performDependenciesAction(
  plan: DependenciesPlan,
  snapshot: SnapshotId,
  port: DependenciesPort,
): Promise<void> {
  const { node } = plan;
  switch (plan.action) {
    case 'showDependencies':
      await port.showDependencies(node, snapshot);
      return;
    case 'showStatistics':
      await port.showStatistics(
        { connectionId: port.connectionId, tableId: node.id, schema: node.schema, table: node.name },
        snapshot,
      );
      return;
    case 'showInTree': {
      const found = await findNode(port.tree, port.connectionId, node);
      if (found) {
        await port.reveal(found);
      } else {
        port.info(
          `The tree does not show "${nodeName(node)}". It may not exist at the snapshot that the tree shows.`,
        );
      }
      return;
    }
    default: {
      const reader = port.tree.reader(port.connectionId);
      if (!reader) {
        throw connectionClosed('use the dependencies');
      }
      const ref = await refOf(reader, port.connectionId, snapshot, node);
      if (!ref) {
        port.info(
          `"${nodeName(node)}" does not exist at snapshot @${snapshot}, so there is no script for it.`,
        );
        return;
      }
      const verbs = { scriptCreate: 'create', scriptAlter: 'alter', scriptDrop: 'drop' } as const;
      const text = await scriptOf(verbs[plan.action], shownAt(port.tree, snapshot), ref);
      if (text !== undefined) {
        await port.openSql(text);
      }
    }
  }
}
