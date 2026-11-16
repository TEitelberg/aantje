import * as vscode from 'vscode';
import { rootOf, shownSnapshot } from '../actions';
import { showError } from '../command.vscode';
import type { Register } from '../command.vscode';
import { createIcebergSettingsPort, createSecretsPort, createWizardUi } from '../connections/ports.vscode';
import type { WizardUi } from '../connections/ports';
import type { ConnectionProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import type { DataAccessFactory } from '../data/resolve';
import { registerIcebergReport } from '../iceberg-report/commands.vscode';
import type { Logger } from '../log';
import { withCancel } from '../progress.vscode';
import type { ReportHostEnv } from '../shell/host.vscode';
import type { CatalogTree } from '../tree/model';
import type { TreeNode } from '../tree/refs';
import { copyToIceberg } from './copy';
import { AantjeError, isAborted, userMessageOf } from '../errors';
import { addIcebergTargetFlow, copyToIcebergFlow, removeIcebergTargetFlow } from './flow';
import type { CopySource, IcebergFlowDeps } from './flow';
import { readCopyPlan, readPartitions } from './plan';
import { readLakeFacts } from './read';
import { syncToIceberg } from './sync';
import { coveredRecords, syncIcebergFlow } from './sync-flow';
import type { SyncFlowDeps, SyncOutcome } from './sync-flow';
import { askedByAssistant, isSyncRequest, REQUEST_SYNC, requestedOutcome } from './sync-request';
import type { RequestedSync } from './sync-request';
import { IcebergCopies } from './records';
import { IcebergStatuses } from './service';
import { IcebergTargetStore } from './store';
import type { IcebergTarget } from './target';

/** The stores of the Iceberg targets and of the copies, and the checks of the copies that the tree shows. */
export function createIcebergStores(
  context: Pick<vscode.ExtensionContext, 'secrets' | 'globalState'>,
  secrets: { add(value: string): void },
  reader: ConstructorParameters<typeof IcebergStatuses>[0]['reader'],
  log: Logger,
): {
  readonly targets: IcebergTargetStore;
  readonly copies: IcebergCopies;
  readonly statuses: IcebergStatuses;
} {
  const targets = new IcebergTargetStore(
    createIcebergSettingsPort(),
    createSecretsPort(context.secrets),
    (value) => secrets.add(value),
  );
  const copies = new IcebergCopies(context.globalState);
  return { targets, copies, statuses: new IcebergStatuses({ targets, copies, reader, log }) };
}

interface IcebergCommandEnv extends ReportHostEnv {
  readonly tree: CatalogTree;
  readonly store: ConnectionStore;
  readonly targets: IcebergTargetStore;
  readonly copies: IcebergCopies;
  readonly statuses: IcebergStatuses;
  readonly dataAccess: DataAccessFactory;
  readonly register: Register;
}

/** Sync to Iceberg on a lake, adding and removing Iceberg targets, and the Iceberg report of a copy. */
export function registerIcebergCommands(env: IcebergCommandEnv): vscode.Disposable[] {
  const { tree, store, targets, copies, register } = env;
  const ui = createWizardUi();

  // A snapshot chosen with Show Catalog at this Snapshot is copied as the tree shows it, so that a copy of an older
  // state is a choice and not an accident. Otherwise the copy reads the newest snapshot that the reader of the tree sees
  // when the copy starts: the live catalog of PostgreSQL and Quack, the file as it was opened for SQLite. The ids of the
  // tables and the check read the same reader, so the copy, its records and the check agree.
  const snapshotOf = async (profile: ConnectionProfile): Promise<number | undefined> => {
    const state = tree.state(profile.id);
    if (state.snapshot !== 'latest') return shownSnapshot(state);
    const info = await tree
      .reader(profile.id)
      ?.info()
      .catch(() => undefined);
    return info?.latestSnapshot ?? shownSnapshot(state);
  };

  const depsFor = (profile: ConnectionProfile, snapshot: number | undefined): IcebergFlowDeps => ({
    targets,
    copies,
    copy: async (request, title) => {
      const access = await env.dataAccess(profile, snapshot);
      try {
        return await withCancel(title, (signal) =>
          copyToIceberg({ ...request, access, report: undefined }, signal),
        );
      } catch (error) {
        // A copy that failed or was cancelled half way may have replaced tables already: check them again.
        afterCopy(profile.id, request.target.id);
        throw error;
      }
    },
    // The ids of the tables, so that a table that is renamed later is not mistaken for a dropped one.
    tableIds: async (at) =>
      new Map(
        ((await tree.reader(profile.id)?.entries(at)) ?? [])
          .filter((entry) => entry.kind === 'table')
          .map((entry) => [`${entry.schemaName}.${entry.name}`, entry.id] as const),
      ),
    // What does not map one to one, from the explorer's reader before anything is written.
    plan: async (scope) => {
      const reader = tree.reader(profile.id);
      return reader && snapshot !== undefined
        ? readCopyPlan(reader, snapshot, scope)
        : { tables: [], partitions: new Map() };
    },
    // A source that an earlier sync to the target covers is brought up to date instead of written new.
    syncCovered: async (target, secret, source) => {
      if (coveredRecords(copies.list(profile.id), target.id, source).length === 0) return undefined;
      const lake = { id: profile.id, name: profile.name };
      const outcome = await syncIcebergFlow(
        ui,
        syncDepsFor(profile, snapshot),
        lake,
        target,
        secret,
        snapshot,
        source,
      );
      return outcome.kind === 'synced' ? 'synced' : 'cancelled';
    },
  });

  /** What the sync of tables synced before reads: the check, the lake's changes, the partitioning, the engine. */
  const syncDepsFor = (profile: ConnectionProfile, snapshot: number | undefined): SyncFlowDeps => {
    const readerOf = () => {
      const reader = tree.reader(profile.id);
      if (!reader)
        throw new AantjeError('ABORTED', `Connect to "${profile.name}" again to sync it to Iceberg.`);
      return reader;
    };
    return {
      copies,
      check: (targetId) => env.statuses.checkOne(profile.id, targetId),
      lakeFacts: (records) => readLakeFacts(readerOf(), records),
      partitions: async (tables) => {
        const reader = readerOf();
        return readPartitions(reader, snapshot ?? (await reader.info()).latestSnapshot, tables);
      },
      tableIds: depsFor(profile, snapshot).tableIds,
      sync: async (request, title) => {
        const access = await env.dataAccess(profile, snapshot);
        try {
          return await withCancel(title, (signal) =>
            syncToIceberg({ ...request, access, report: undefined }, signal),
          );
        } finally {
          // A sync that failed or was cancelled half way may have written tables already: check them again.
          afterCopy(profile.id, request.target.id);
        }
      },
    };
  };

  /** Brings what the source covers of a sync to the target up to date, after the question of the sync. */
  const syncOf = async (
    profile: ConnectionProfile,
    target: IcebergTarget,
    source: CopySource,
    asker: WizardUi = ui,
  ): Promise<SyncOutcome> => {
    const snapshot = await snapshotOf(profile);
    const lake = { id: profile.id, name: profile.name };
    const secret = await targets.secret(target);
    return syncIcebergFlow(asker, syncDepsFor(profile, snapshot), lake, target, secret, snapshot, source);
  };

  /** What Sync to Iceberg was started on: the connection, a schema or a table. */
  const sourceOf = (node: TreeNode): CopySource => {
    const { ref } = node;
    if (ref.kind === 'schema') return { kind: 'schema', schema: ref.schema.name };
    if (ref.kind === 'table') return { kind: 'table', schema: ref.schema.name, table: ref.table.name };
    return { kind: 'lake' };
  };

  /**
   * After a copy the lake is the same and its copies are not: the level below the connection is read again without
   * reopening it (which checks the copies and adds the row of a new target), and the report of the copy if it is open.
   */
  const afterCopy = (connectionId: string, targetId: string): void => {
    tree.reread(connectionId);
    report.refresh(connectionId, targetId);
  };

  const { report, disposables } = registerIcebergReport({
    ...env,
    actions: {
      // Sync to Apache Iceberg in the report: everything synced to the target, brought up to date.
      copyAgain: async (connectionId, targetId) => {
        const profile = store.get(connectionId);
        const target = targets.get(targetId);
        if (profile && target) await syncOf(profile, target, { kind: 'lake' });
      },
      forget: async (connectionId, targetId) => {
        const target = targets.get(targetId);
        if (!target) return;
        const confirmed = await ui.confirm(
          `Forget the copy of this lake in ${target.name}? aantje deletes its record and the row in the tree; the Iceberg tables stay in the catalog.`,
          'Forget',
        );
        if (!confirmed) return;
        await copies.forget({ connectionId, targetId });
        // Forget drops a row of the tree: read the connection again.
        const root = rootOf(tree, connectionId);
        if (root) tree.refresh(root);
      },
    },
  });

  return [
    ...disposables,
    register('aantje.syncToIceberg', async (node) => {
      const profile = node && store.get(node.ref.connectionId);
      if (!profile) return;
      const snapshot = await snapshotOf(profile);
      const copied = await copyToIcebergFlow(
        ui,
        depsFor(profile, snapshot),
        { id: profile.id, name: profile.name },
        snapshot,
        sourceOf(node),
      );
      if (copied) afterCopy(profile.id, copied.target.id);
    }),

    registerSyncRequest(env, (profile, target, source, asker) => syncOf(profile, target, source, asker)),

    register('aantje.addIcebergTarget', async () => {
      const target = await addIcebergTargetFlow(ui, { targets });
      if (target) void vscode.window.showInformationMessage(`Saved the Iceberg target "${target.name}".`);
    }),

    register('aantje.removeIcebergTarget', async () => {
      await removeIcebergTargetFlow(ui, { targets, copies });
    }),
  ];
}

/**
 * For aantje's MCP server: a sync of what was synced to a target, asked for by an assistant. The question in VS Code is
 * the one of the command and says that an assistant asks; nothing is written unless the user says yes there.
 */
function registerSyncRequest(
  env: Pick<IcebergCommandEnv, 'store' | 'targets' | 'copies' | 'logger'>,
  sync: (
    profile: ConnectionProfile,
    target: IcebergTarget,
    source: CopySource,
    asker: WizardUi,
  ) => Promise<SyncOutcome>,
): vscode.Disposable {
  const ui = createWizardUi();
  const asker: WizardUi = {
    ...ui,
    confirm: (message, action) => ui.confirm(askedByAssistant(message), action),
  };
  return vscode.commands.registerCommand(
    REQUEST_SYNC,
    async (request: unknown): Promise<RequestedSync | undefined> => {
      if (!isSyncRequest(request)) return undefined;
      const profile = env.store.get(request.connectionId);
      const target = env.targets.get(request.targetId);
      if (!profile || !target) return undefined;
      if (coveredRecords(env.copies.list(profile.id), target.id, request.source).length === 0) {
        return { kind: 'uncovered' };
      }
      try {
        return requestedOutcome(await sync(profile, target, request.source, asker));
      } catch (error) {
        if (isAborted(error)) return { kind: 'cancelled' };
        env.logger.error('The sync to Iceberg that the MCP server asked for failed.', error);
        showError(error);
        return { kind: 'failed', message: userMessageOf(error) };
      }
    },
  );
}
