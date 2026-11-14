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
import { ArmClient } from './arm';
import { allowMyIpFlow } from './allow-ip';
import { attachNewLake } from './attach-lake';
import type { AzureAuth } from './auth.vscode';
import { azureNotebookConfig } from './config-export';
import { pendingNotice } from './pending';
import type { PendingLakes } from './pending';
import { discoverPublicIp } from './public-ip';
import { unattachedNotice } from './registry';
import type { LakeRegistry } from './registry';
import { createLakeFlow, finishLakeFlow } from './create-flow';
import { deleteLakeFlow } from './delete-flow';
import { importLakeFlow } from './import-flow';

interface AzureCommandEnv {
  readonly store: ConnectionStore;
  readonly registry: LakeRegistry;
  readonly pending: PendingLakes;
  readonly auth: AzureAuth;
  readonly dataAccess: DataAccessFactory;
  readonly connect: ConnectDeps;
  readonly trust: ViewTrustStore;
  readonly history: Pick<QueryHistory, 'clear'>;
  readonly register: Register;
  readonly logger: Logger;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Create, finish, import, delete, Allow my IP and Copy Azure Config of an Azure DuckLake. */
export function registerAzureCommands(env: AzureCommandEnv): vscode.Disposable[] {
  const { store, registry, pending, auth, register, logger: log } = env;
  const ui = createWizardUi();
  const arm = new ArmClient({
    token: () => auth.armToken(),
    debug: (message) => log.debug(`Azure: ${message}`),
  });
  // The connection is saved before it is attached, so a failing attach does not lose the generated password.
  const attach = async (
    profile: PostgresProfile,
    dataPath: string,
    report: (step: string) => void,
  ): Promise<void> =>
    attachNewLake(await env.dataAccess(profile, undefined), dataPath, { sleep, report, log });

  // A deployment that was interrupted by closing the editor or reloading the window waits for Finish Creating.
  const notice = pendingNotice(pending.list());
  if (notice !== undefined) {
    const finish = 'Finish';
    void vscode.window.showWarningMessage(notice, finish).then((answer) => {
      if (answer === finish) {
        void vscode.commands.executeCommand('aantje.finishAzureLake');
      }
    });
  }

  // A lake that was saved as a connection but whose first attach never finished: the mark is set before the attach and
  // cleared after it, so it also catches a failed attach whose message is long gone.
  for (const { connectionId, dataPath } of registry.unattached()) {
    const profile = store.get(connectionId);
    if (profile?.kind !== 'postgres') {
      void registry.markAttached(connectionId);
      continue;
    }
    const attachNow = 'Attach now';
    void vscode.window.showWarningMessage(unattachedNotice(profile.name), attachNow).then(async (answer) => {
      if (answer !== attachNow) {
        return;
      }
      try {
        await ui.withProgress(`Attaching the Azure DuckLake "${profile.name}"...`, async (report) => {
          await attach(profile, dataPath, report);
        });
        await registry.markAttached(connectionId);
        ui.info(`Attached the Azure DuckLake "${profile.name}".`);
      } catch (error) {
        ui.error(`Attaching "${profile.name}" failed: ${userMessageOf(error)}`);
      }
    });
  }

  return [
    register('aantje.createAzureLake', async () => {
      await createLakeFlow(ui, {
        arm,
        signIn: (tenantId) => auth.signIn(tenantId),
        token: () => auth.armToken(),
        publicIp: () => discoverPublicIp(),
        store,
        registry,
        pending,
        attach,
        log,
      });
    }),

    register('aantje.finishAzureLake', async () => {
      await finishLakeFlow(ui, {
        arm,
        signIn: (tenantId) => auth.signIn(tenantId),
        store,
        registry,
        pending,
        attach,
        log,
      });
    }),

    register('aantje.importAzureLake', async () => {
      await importLakeFlow(ui, {
        store,
        clipboard: () => Promise.resolve(vscode.env.clipboard.readText()),
        test: async (profile, password) => {
          await testConnection(profile, password, env.connect);
        },
        entraUser: () => auth.entraUser(undefined),
        log,
      });
    }),

    register('aantje.allowMyIp', async (node) => {
      const profile = node && store.get(node.ref.connectionId);
      if (profile?.kind !== 'postgres') {
        return;
      }
      await allowMyIpFlow(ui, profile, {
        arm,
        signIn: (tenantId) => auth.signIn(tenantId),
        publicIp: () => discoverPublicIp(),
        registry,
        log,
      });
    }),

    register('aantje.copyAzureConfig', async (node) => {
      const profile = node && store.get(node.ref.connectionId);
      const config = profile?.kind === 'postgres' ? azureNotebookConfig(profile) : undefined;
      if (config === undefined) {
        return;
      }
      await vscode.env.clipboard.writeText(config);
      vscode.window.setStatusBarMessage('Copied the Azure config for azure.config.json', 4000);
    }),

    register('aantje.deleteAzureLake', async (node) => {
      const profile = node && store.get(node.ref.connectionId);
      if (profile?.kind !== 'postgres') {
        return;
      }
      await deleteLakeFlow(ui, profile, {
        arm,
        signIn: (tenantId) => auth.signIn(tenantId),
        registry,
        removeConnection: async (removed) => {
          await store.remove(removed.id);
          await env.trust.revoke(removed);
          await env.history.clear(removed.id);
        },
        log,
        sleep,
        // The follow-up logs its own end and failure; nothing waits for it.
        background: (task) => void task,
      });
    }),
  ];
}
