import type * as vscode from 'vscode';
import { catalogAt, shownSnapshot } from '../actions';
import { showConnectFirst } from '../command.vscode';
import type { Register } from '../command.vscode';
import type { SnapshotId } from '../catalog/model';
import { withCancel } from '../progress.vscode';
import type { ReportPanels } from '../shell/panels';
import type { CatalogTree } from '../tree/model';
import type { StatisticsData } from './model';
import { statisticsKey, statisticsTargetOf, statisticsTitle } from './target';
import type { StatisticsTarget } from './target';

interface StatisticsCommandEnv {
  readonly tree: CatalogTree;
  readonly connectionName: (connectionId: string) => string | undefined;
  readonly panels: ReportPanels<StatisticsData, never, never>;
  readonly register: Register;
}

const GOAL = 'show the statistics';

/** Reads the statistics of a table at a snapshot and shows them; the other reports use it too. */
export async function showStatistics(
  env: Pick<StatisticsCommandEnv, 'tree' | 'connectionName' | 'panels'>,
  target: StatisticsTarget,
  snapshot: SnapshotId,
): Promise<void> {
  const { tree, panels } = env;
  const { reader } = catalogAt(tree, target.connectionId, GOAL);
  const name = `${target.schema}.${target.table}`;
  const key = statisticsKey(target, snapshot);
  const statistics = await panels.read(key, (outer) =>
    withCancel(
      `Reading the statistics of ${name}...`,
      (signal) => reader.tableStatistics(target.tableId, snapshot, signal),
      outer,
    ),
  );
  if (!statistics) {
    return;
  }
  const connection = env.connectionName(target.connectionId) ?? target.connectionId;
  panels.show(key, statisticsTitle(target, connection, snapshot), {
    table: name,
    connection,
    statistics,
  });
}

/** Show Statistics: the statistics report of a table at the snapshot that the tree shows. */
export function registerStatisticsCommand(env: StatisticsCommandEnv): vscode.Disposable[] {
  return [
    env.register('aantje.showStatistics', async (node) => {
      const target = node && statisticsTargetOf(node.ref);
      if (!target) {
        return;
      }
      const snapshot = shownSnapshot(env.tree.state(target.connectionId));
      // As every other report command: a hint, not an error. `showStatistics` keeps the error for a call mid-flow.
      if (snapshot === undefined || !env.tree.reader(target.connectionId)) {
        showConnectFirst(GOAL);
        return;
      }
      await showStatistics(env, target, snapshot);
    }),
  ];
}
