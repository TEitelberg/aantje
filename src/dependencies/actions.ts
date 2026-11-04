import type { DependencyNode } from './graph';
import type { DependenciesData } from './model';
import type { DependenciesActionId } from './protocol';

export interface DependenciesRequest {
  readonly action: DependenciesActionId;
  readonly node: number;
}

/** What a request from the page asks for: an action on an object the extension sent. */
export interface DependenciesPlan {
  readonly action: DependenciesActionId;
  readonly node: DependencyNode;
}

/** The action for a request; undefined for an unknown node, or statistics of something that is no table. */
export function planDependenciesAction(
  data: DependenciesData,
  request: DependenciesRequest,
): DependenciesPlan | undefined {
  const node = Number.isInteger(request.node) ? data.nodes[request.node] : undefined;
  if (!node || (request.action === 'showStatistics' && node.kind !== 'table')) {
    return undefined;
  }
  return { action: request.action, node };
}
