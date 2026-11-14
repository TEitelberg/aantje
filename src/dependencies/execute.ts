import { findEntryNode, nodeOf } from '../actions';
import type { SnapshotId } from '../catalog/model';
import type { StatisticsTarget } from '../stats/target';
import type { CatalogTree } from '../tree/model';
import type { TreeNode } from '../tree/refs';
import type { DependenciesPlan } from './actions';
import type { DependencyNode } from './graph';
import { nodeName } from './model';

/** What the actions of the report do in VS Code; the plan says what, the port does it. */
export interface DependenciesPort {
  readonly connectionId: string;
  readonly tree: Pick<CatalogTree, 'roots' | 'children'>;
  reveal(node: TreeNode): Promise<void>;
  showStatistics(target: StatisticsTarget, snapshot: SnapshotId): Promise<void>;
  showDependencies(node: DependencyNode, snapshot: SnapshotId): Promise<void>;
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
  const schema = await nodeOf(tree, connectionId, node.schemaId);
  const folder = (schema ? await tree.children(schema) : []).find(
    ({ ref }) => ref.kind === 'folder' && ref.folder === 'macros',
  );
  return (folder ? await tree.children(folder) : []).find(
    ({ ref }) => ref.kind === 'macro' && ref.macro.id === node.id,
  );
}

/** Carries out a plan of the Dependencies report at the report's snapshot. */
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
    }
  }
}
