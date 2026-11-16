import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Register } from '../command.vscode';
import { testConnection } from '../connections/connect';
import type { ConnectDeps } from '../connections/connect';
import { createWizardUi } from '../connections/ports.vscode';
import type { PostgresProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import type { DataAccessFactory } from '../data/resolve';
import type { ViewTrustStore } from '../data/trust';
import { userMessageOf } from '../errors';
import type { Logger } from '../log';
import type { QueryHistory } from '../sql/history';
import { whenShown } from '../tree/shown';
import type { ShownView } from '../tree/shown';
import template from '../../deploy/aws/template.yaml';
import { attachNewLake } from '../azure/attach-lake';
import { discoverPublicIp } from '../azure/public-ip';
import { runAsAdmin } from './admin-sql';
import { allowAwsIpFlow } from './allow-ip';
import { finishAwsLakeFlow, createAwsLakeFlow } from './create-flow';
import { deleteAwsLakeFlow } from './delete-flow';
import { importAwsLakeFlow } from './import-flow';
import type { AwsFlowDeps } from './create-flow';
import { loadAwsSdk } from './load';
import { pendingAwsNotice } from './pending';
import type { PendingAwsLakes } from './pending';
import { environmentHasKeys, environmentRegion, readAwsProfiles } from './profiles';
import { unattachedAwsNotice } from './registry';
import type { AwsLakeRegistry } from './registry';

interface AwsCommandEnv {
  readonly extensionPath: string;
  readonly store: ConnectionStore;
  /** The view of aantje: the notices of an interrupted run wait until the user sees it. */
  readonly view: ShownView;
  readonly registry: AwsLakeRegistry;
  readonly pending: PendingAwsLakes;
  readonly dataAccess: DataAccessFactory;
  readonly connect: ConnectDeps;
  readonly trust: ViewTrustStore;
  readonly history: Pick<QueryHistory, 'clear'>;
  readonly register: Register;
  readonly logger: Logger;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Create, finish, import and delete an AWS DuckLake, Allow My IP, and the notices of an interrupted creation. */
export function registerAwsCommands(env: AwsCommandEnv): vscode.Disposable[] {
  const { store, registry, pending, register, logger: log } = env;
  const ui = createWizardUi();
  const attach = async (
    profile: PostgresProfile,
    dataPath: string,
    report: (step: string) => void,
  ): Promise<void> =>
    attachNewLake(await env.dataAccess(profile, undefined), dataPath, {
      sleep,
      report,
      log,
      storageName: 'the bucket',
    });
  const deps = (): AwsFlowDeps => ({
    profiles: () => readAwsProfiles(),
    environment: { hasKeys: environmentHasKeys(), region: environmentRegion() },
    api: (options) =>
      Promise.resolve(
        loadAwsSdk(join(env.extensionPath, 'dist', 'aws-sdk.js')).createAwsApi({
          ...options,
          debug: (line) => log.debug(`AWS ${options.region}: ${line}`),
        }),
      ),
    template,
    publicIp: () => discoverPublicIp(),
    store,
    registry,
    pending,
    attach,
    runAsAdmin,
    sleep,
    log,
  });

  // Of what was pending when this window started and still is; a run that this window starts later is not interrupted.
  const pendingAtStart = new Set(pending.list().map(({ stackId }) => stackId));
  const unattachedAtStart = new Set(registry.unattached().map(({ connectionId }) => connectionId));
  const notices = whenShown(env.view, () => {
    const notice = pendingAwsNotice(pending.list().filter(({ stackId }) => pendingAtStart.has(stackId)));
    if (notice !== undefined) {
      const finish = 'Finish';
      void vscode.window.showWarningMessage(notice, finish).then((answer) => {
        if (answer === finish) void vscode.commands.executeCommand('aantje.finishAwsLake');
      });
    }
    for (const { connectionId, dataPath } of registry.unattached()) {
      if (!unattachedAtStart.has(connectionId)) continue;
      const profile = store.get(connectionId);
      if (profile?.kind !== 'postgres') {
        void registry.markAttached(connectionId);
        continue;
      }
      const attachNow = 'Attach now';
      void vscode.window
        .showWarningMessage(unattachedAwsNotice(profile.name), attachNow)
        .then(async (answer) => {
          if (answer !== attachNow) return;
          try {
            await ui.withProgress(`Attaching the AWS DuckLake "${profile.name}"...`, (report) =>
              attach(profile, dataPath, report),
            );
            await registry.markAttached(connectionId);
            ui.info(`Attached the AWS DuckLake "${profile.name}".`);
          } catch (error) {
            ui.error(`Attaching "${profile.name}" failed: ${userMessageOf(error)}`);
          }
        });
    }
  });

  return [
    notices,
    register('aantje.createAwsLake', async () => {
      await createAwsLakeFlow(ui, deps());
    }),
    register('aantje.finishAwsLake', async () => {
      await finishAwsLakeFlow(ui, deps());
    }),
    register('aantje.importAwsLake', async () => {
      await importAwsLakeFlow(ui, {
        ...deps(),
        store,
        clipboard: () => Promise.resolve(vscode.env.clipboard.readText()),
        test: async (profile, password) => {
          await testConnection(profile, password, env.connect);
        },
      });
    }),
    register('aantje.allowMyIpAws', async (node) => {
      const profile = node && store.get(node.ref.connectionId);
      if (profile?.kind !== 'postgres') return;
      await allowAwsIpFlow(ui, profile, { ...deps(), registry });
    }),
    register('aantje.deleteAwsLake', async (node) => {
      const profile = node && store.get(node.ref.connectionId);
      if (profile?.kind !== 'postgres') return;
      await deleteAwsLakeFlow(ui, profile, {
        ...deps(),
        registry,
        removeConnection: async (removed) => {
          await store.remove(removed.id);
          await env.trust.revoke(removed);
          await env.history.clear(removed.id);
        },
      });
    }),
  ];
}
