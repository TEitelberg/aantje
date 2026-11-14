import * as vscode from 'vscode';
import type { ActiveConnection } from './active-connection.vscode';
import { catalogAt } from './actions';
import type { Register } from './command.vscode';
import { connectedTarget } from './commands.vscode';
import { compareSchema, snapshotsReport } from './compare';
import type { SchemaDocuments } from './compare.vscode';
import type { ConnectionStore } from './connections/store';
import { pickOne, timeTravelUi } from './pick.vscode';
import { openMarkdown } from './shell/host.vscode';
import { snapshotChoices, snapshotPickItems } from './snapshot';
import { choosePair, chooseRange, subjectOf } from './time-travel';
import type { CatalogTree } from './tree/model';
import type { TreeNode } from './tree/refs';

interface TimeTravelCommandEnv {
  readonly tree: CatalogTree;
  readonly store: ConnectionStore;
  readonly active: ActiveConnection;
  /** The documents of the schema diff; the snapshot report shows them too. */
  readonly schemaDocuments: SchemaDocuments;
  readonly register: Register;
}

/** Choose the snapshot the tree shows, and compare a table's schema or two snapshots of a connection. */
export function registerTimeTravelCommands(env: TimeTravelCommandEnv): vscode.Disposable[] {
  const { tree, active, schemaDocuments, register } = env;
  const connected = (node: TreeNode | undefined, goal: string) => connectedTarget(env, node, goal);

  /** The reader and the shown snapshot behind a table node; a closed connection is an error, like for Script as. */
  const tableOf = (node: TreeNode | undefined, goal: string) => {
    const subject = node && subjectOf(node.ref);
    if (!node || subject?.kind !== 'table') {
      return undefined;
    }
    const { connectionId } = node.ref;
    const { reader, snapshot } = catalogAt(tree, connectionId, goal);
    return { reader, subject, connectionId, shown: snapshot };
  };

  return [
    register('aantje.selectSnapshot', async (node) => {
      const target = connected(node, 'choose a snapshot');
      if (target?.state.latestSnapshot === undefined) {
        return;
      }
      const items = snapshotPickItems(await target.reader.snapshots(), {
        selected: target.state.snapshot,
        latest: target.state.latestSnapshot,
      });
      const choice = await pickOne(items, {
        title: `Snapshot of "${target.profile.name}"`,
        placeholder: 'Choose the snapshot the tree shows',
        active: items.filter((item) => item.picked),
      });
      if (choice) {
        tree.selectSnapshot(target.profile.id, choice.value);
        active.select(target.profile.id);
      }
    }),

    register('aantje.showSnapshot', (node) => {
      if (node?.ref.kind === 'snapshot') {
        tree.selectSnapshot(node.ref.connectionId, node.ref.snapshot.id);
        active.select(node.ref.connectionId);
      }
    }),

    register('aantje.showLatestSnapshot', (node) => {
      const target = connected(node, 'show its latest snapshot');
      if (!target) {
        return;
      }
      if (target.state.snapshot === 'latest') {
        void vscode.window.showInformationMessage(
          `"${target.profile.name}" already shows the latest snapshot.`,
        );
        return;
      }
      tree.selectSnapshot(target.profile.id, 'latest');
      active.select(target.profile.id);
    }),

    register('aantje.compareSchema', async (node) => {
      const target = tableOf(node, 'compare its schema');
      const range = target && (await chooseRange(timeTravelUi, target.reader, target.subject, target.shown));
      if (!target || !range) {
        return;
      }
      const comparison = await compareSchema(
        target.reader,
        target.connectionId,
        target.subject,
        range.from,
        range.to,
      );
      await schemaDocuments.show(comparison);
      void vscode.window.showInformationMessage(comparison.summary);
    }),

    register('aantje.compareSnapshots', async (node) => {
      const target = node?.ref.kind === 'connection' ? connected(node, 'compare snapshots') : undefined;
      if (!target) {
        return;
      }
      const snapshots = await target.reader.snapshots();
      const range = await choosePair(
        timeTravelUi,
        snapshotChoices(snapshots, target.snapshot),
        `"${target.profile.name}"`,
      );
      if (!range) {
        return;
      }
      const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Comparing snapshots...' },
        () => snapshotsReport(target.reader, target.profile.name, snapshots, range.from, range.to),
      );
      await openMarkdown(report);
    }),
  ];
}
