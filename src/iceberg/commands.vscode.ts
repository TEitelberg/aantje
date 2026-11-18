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
import { copyToIceberg, describeTarget } from './copy';
import type { CopyRequest, CopyResult, IcebergName } from './copy';
import { AantjeError, isAborted, userMessageOf } from '../errors';
import { FabricApi } from '../fabric/api';
import { waitForConversion } from '../fabric/conversion';
import type { AzureAuth } from '../azure/auth.vscode';
import { addTargetFlow, copyToIcebergFlow, removeIcebergTargetFlow } from './flow';
import type { CopySource, IcebergFlowDeps } from './flow';
import { extraCastsOf } from './mapping';
import { readCopyPlan, readPartitions } from './plan';
import { readLakeFacts } from './read';
import { icebergNameOfRecord, syncToIceberg } from './sync';
import type { SyncRequest, SyncResult } from './sync';
import { coveredRecords, syncIcebergFlow } from './sync-flow';
import type { SyncFlowDeps, SyncOutcome } from './sync-flow';
import { askedByAssistant, isSyncRequest, REQUEST_SYNC, requestedOutcome } from './sync-request';
import type { RequestedSync } from './sync-request';
import { IcebergCopies } from './records';
import { IcebergStatuses } from './service';
import { IcebergTargetStore } from './store';
import type { IcebergTarget } from './target';

/**
 * The stores of the Iceberg targets and of the copies, the checks of the copies that the tree shows, and the Fabric API.
 * A Fabric lakehouse target signs in with the Microsoft account of VS Code: to OneLake for the sync, to the Fabric API
 * for its workspaces and lakehouses; every call of that API is written to the aantje output.
 */
export function createIcebergStores(
  context: Pick<vscode.ExtensionContext, 'secrets' | 'globalState'>,
  secrets: { add(value: string): void },
  reader: ConstructorParameters<typeof IcebergStatuses>[0]['reader'],
  log: Logger,
  auth: Pick<AzureAuth, 'storageAccess' | 'fabricToken'>,
): {
  readonly targets: IcebergTargetStore;
  readonly copies: IcebergCopies;
  readonly statuses: IcebergStatuses;
  readonly fabric: (tenant: string | undefined) => FabricApi;
} {
  const targets = new IcebergTargetStore(
    createIcebergSettingsPort(),
    createSecretsPort(context.secrets),
    (value) => secrets.add(value),
    async (target, silent) =>
      (await auth.storageAccess('onelake', target.fabric?.tenant, silent)).accessToken,
  );
  const copies = new IcebergCopies(context.globalState);
  return {
    targets,
    copies,
    statuses: new IcebergStatuses({ targets, copies, reader, log }),
    fabric: (tenant) => new FabricApi({ token: () => auth.fabricToken(tenant), log }),
  };
}

interface IcebergCommandEnv extends ReportHostEnv {
  readonly tree: CatalogTree;
  readonly store: ConnectionStore;
  readonly targets: IcebergTargetStore;
  readonly copies: IcebergCopies;
  readonly statuses: IcebergStatuses;
  readonly fabric: (tenant: string | undefined) => FabricApi;
  readonly dataAccess: DataAccessFactory;
  readonly register: Register;
}

/**
 * Before each table of a sync to a Fabric lakehouse: the token of the Microsoft account now, without asking. A new one
 * (the account renews it about every hour) is written to the aantje output, and the sync puts it into its engine.
 */
function freshSecretOf(
  targets: Pick<IcebergTargetStore, 'secret'>,
  log: Logger,
  request: { readonly target: IcebergTarget; readonly secret: string | undefined },
): (() => Promise<string | undefined>) | undefined {
  if (!request.target.fabric) return undefined;
  let last = request.secret;
  return async () => {
    const next = await targets.secret(request.target);
    if (next !== undefined && next !== last) {
      last = next;
      log.info(
        'Sync to Iceberg: the Microsoft account has a new token; aantje attaches the catalog of OneLake again.',
      );
    }
    return next;
  };
}

interface Runner {
  readonly targets: Pick<IcebergTargetStore, 'secret'>;
  readonly logger: Logger;
  readonly fabric: (tenant: string | undefined) => Pick<FabricApi, 'sqlEndpointOf' | 'refreshSqlEndpoint'>;
}

/**
 * A sync in the aantje output and under a notification with Cancel: what it writes, each table when it is done (the
 * notification names the table that runs now), and how many it wrote. A Fabric lakehouse renews its token on the way.
 */
async function logged<
  T extends { readonly snapshot: number; readonly tables: readonly { readonly status: string }[] },
>(
  env: Runner,
  title: string,
  target: IcebergTarget,
  run: (signal: AbortSignal, progress: Pick<CopyRequest, 'report' | 'stepDone'>) => Promise<T>,
): Promise<T> {
  const log = env.logger;
  log.info(`Sync to Iceberg: ${title}`);
  const result = await withCancel(title, (signal, report) =>
    run(signal, {
      report,
      stepDone: (line, ok) => {
        if (ok) log.info(`Sync to Iceberg: ${line}`);
        else log.warn(`Sync to Iceberg: ${line}`);
      },
    }),
  );
  const failed = result.tables.filter((table) => table.status === 'failed').length;
  log.info(
    `Sync to Iceberg: ${result.tables.length - failed} of ${result.tables.length} tables written to ${describeTarget(target)} at snapshot ${result.snapshot}.`,
  );
  return result;
}

/** A first sync, see `logged`; for a Fabric lakehouse `afterFabricSync` follows. */
async function runCopy(
  env: Runner,
  request: Omit<CopyRequest, 'report'>,
  title: string,
): Promise<CopyResult> {
  const freshSecret = freshSecretOf(env.targets, env.logger, request);
  const result = await logged(env, title, request.target, (signal, progress) =>
    copyToIceberg({ ...request, ...progress, ...(freshSecret ? { freshSecret } : {}) }, signal),
  );
  void afterFabricSync(
    env,
    request.target,
    result.tables.filter((table) => table.status === 'copied').map((table) => table.iceberg),
  );
  return result;
}

/** The sync of tables synced before, see `logged`; for a Fabric lakehouse `afterFabricSync` follows. */
async function runSync(
  env: Runner,
  request: Omit<SyncRequest, 'report'>,
  title: string,
): Promise<SyncResult> {
  const freshSecret = freshSecretOf(env.targets, env.logger, request);
  const result = await logged(env, title, request.target, (signal, progress) =>
    syncToIceberg({ ...request, ...progress, ...(freshSecret ? { freshSecret } : {}) }, signal),
  );
  void afterFabricSync(
    env,
    request.target,
    result.tables
      .filter((table) => table.status === 'synced')
      .map((table) => icebergNameOfRecord(table.step)),
  );
  return result;
}

/**
 * After a sync to a Fabric lakehouse, under a notification of its own: waits until Fabric has converted the tables the
 * sync wrote to Delta, then lets the SQL analytics endpoint read them again, so that it does not report them as
 * `DeltaTableNotFound`. Every table goes to the aantje output; a problem here is a warning and never fails the sync.
 */
async function afterFabricSync(
  env: Runner,
  target: IcebergTarget,
  names: readonly IcebergName[],
): Promise<void> {
  const { fabric } = target;
  if (!fabric || names.length === 0) return;
  const log = env.logger;
  try {
    await withCancel(`Waiting until Fabric shows the tables of ${target.name}...`, async (signal, report) => {
      const token = await env.targets.secret(target);
      if (token === undefined) {
        log.warn(
          'Fabric: no token of the Microsoft account, so the conversion of the tables is not checked.',
        );
        return;
      }
      log.info(
        `Fabric: waiting until Fabric has converted ${names.length} tables to Delta (up to 3 minutes).`,
      );
      const conversions = await waitForConversion(target, token, names, { signal, report });
      for (const { table, state, detail } of conversions) {
        const name = `${table.namespace}.${table.name}`;
        if (state === 'converted') log.info(`Fabric: ${name} is converted to Delta.`);
        else if (state === 'failed')
          log.warn(`Fabric: the conversion of ${name} failed: ${detail ?? 'no reason'}`);
        else log.warn(`Fabric: ${name} was not converted within 3 minutes; Fabric may still be at it.`);
      }
      const converted = conversions
        .filter((conversion) => conversion.state === 'converted')
        .map(({ table }) => ({ schema: table.namespace, name: table.name }));
      if (converted.length === 0 || signal.aborted) return;
      const api = env.fabric(fabric.tenant);
      const endpoint = await api.sqlEndpointOf(fabric.workspace, fabric.lakehouse);
      if (endpoint === undefined) {
        log.warn(
          'Fabric: the lakehouse has no SQL analytics endpoint yet; it reads the tables when it is ready.',
        );
        return;
      }
      report('The SQL analytics endpoint reads the tables');
      const read = await api.refreshSqlEndpoint(fabric.workspace, endpoint, converted, report);
      const failed = read.filter((table) => table.status === 'Failure');
      log.info(
        `Fabric: the SQL analytics endpoint read ${read.length - failed.length} of ${read.length} tables.`,
      );
      for (const table of failed) {
        log.warn(
          `Fabric: the SQL analytics endpoint could not read ${table.name}: ${table.error ?? 'no reason'}`,
        );
      }
    });
  } catch (error) {
    if (!isAborted(error))
      log.warn(`Fabric: checking the tables after the sync failed: ${userMessageOf(error)}`);
  }
}

/** Sync to Iceberg on a lake, adding and removing Iceberg targets, and the Iceberg report of a copy. */
export function registerIcebergCommands(env: IcebergCommandEnv): vscode.Disposable[] {
  const { tree, store, targets, copies, register, fabric } = env;
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
    fabric,
    copy: async (request, title) => {
      const access = await env.dataAccess(profile, snapshot);
      try {
        return await runCopy(env, { ...request, access }, title);
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
    plan: async (scope, target) => {
      const reader = tree.reader(profile.id);
      return reader && snapshot !== undefined
        ? readCopyPlan(reader, snapshot, scope, extraCastsOf(target))
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
          return await runSync(env, { ...request, access }, title);
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
    // Started by the user (or an assistant the user answers): a Fabric target may ask to sign in.
    const secret = await targets.secret(target, true);
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

  const actions = {
    // Sync to Iceberg in the report and on the row: everything synced to the target, brought up to date.
    copyAgain: async (connectionId: string, targetId: string) => {
      const profile = store.get(connectionId);
      const target = targets.get(targetId);
      if (profile && target) await syncOf(profile, target, { kind: 'lake' });
    },
    forget: async (connectionId: string, targetId: string) => {
      const target = targets.get(targetId);
      if (!target) return;
      const confirmed = await ui.confirm(
        `Forget the Iceberg sync of this lake to ${target.name}? aantje deletes its record and the row in the tree; the Iceberg tables stay in the catalog.`,
        'Forget',
      );
      if (!confirmed) return;
      await copies.forget({ connectionId, targetId });
      // Forget drops a row of the tree: read the connection again.
      const root = rootOf(tree, connectionId);
      if (root) tree.refresh(root);
    },
  };
  const { report, disposables } = registerIcebergReport({ ...env, actions });

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
      const target = await addTargetFlow(ui, { targets, fabric });
      if (target) void vscode.window.showInformationMessage(`Saved the Iceberg target "${target.name}".`);
    }),

    register('aantje.removeIcebergTarget', async () => {
      await removeIcebergTargetFlow(ui, { targets, copies });
    }),

    ...registerRowCommands(register, actions, env.statuses, report),
  ];
}

/** The context menu of the row of a sync in the tree: what the header of its report offers. */
function registerRowCommands(
  register: Register,
  actions: Readonly<
    Record<'copyAgain' | 'forget', (connectionId: string, targetId: string) => Promise<void>>
  >,
  statuses: Pick<IcebergStatuses, 'checkOne'>,
  report: { refresh(connectionId: string, targetId: string): void },
): vscode.Disposable[] {
  return [
    register('aantje.syncIcebergRow', async (node) => {
      const row = icebergRowOf(node);
      if (row) await actions.copyAgain(row.connectionId, row.targetId);
    }),
    register('aantje.refreshIcebergRow', async (node) => {
      const row = icebergRowOf(node);
      if (!row) return;
      await statuses.checkOne(row.connectionId, row.targetId).catch(() => undefined);
      report.refresh(row.connectionId, row.targetId);
    }),
    register('aantje.forgetIcebergSync', async (node) => {
      const row = icebergRowOf(node);
      if (row) await actions.forget(row.connectionId, row.targetId);
    }),
  ];
}

/** The connection and the target of the row of an Iceberg sync in the tree. */
function icebergRowOf(node: TreeNode | undefined): { connectionId: string; targetId: string } | undefined {
  const ref = node?.ref;
  return ref?.kind === 'folder' && ref.folder === 'iceberg'
    ? { connectionId: ref.connectionId, targetId: ref.targetId }
    : undefined;
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
