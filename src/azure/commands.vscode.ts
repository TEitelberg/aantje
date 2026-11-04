import * as vscode from 'vscode';
import type { Register } from '../command.vscode';
import { openWithPassword } from '../connections/connect';
import type { ConnectDeps } from '../connections/connect';
import { createWizardUi } from '../connections/ports.vscode';
import type { PostgresProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import type { DataAccessFactory } from '../data/resolve';
import type { ViewTrustStore } from '../data/trust';
import type { Logger } from '../log';
import { ArmClient } from './arm';
import { allowMyIpFlow } from './allow-ip';
import { attachNewLake } from './attach-lake';
import type { AzureAuth } from './auth.vscode';
import { azureNotebookConfig } from './config-export';
import { requireUserName } from './jwt';
import type { PendingLakes } from './pending';
import { discoverPublicIp } from './public-ip';
import type { LakeRegistry } from './registry';
import { createLakeFlow, deleteLakeFlow, finishLakeFlow, importLakeFlow } from './wizard';

interface AzureCommandEnv {
  readonly store: ConnectionStore;
  readonly registry: LakeRegistry;
  readonly pending: PendingLakes;
  readonly auth: AzureAuth;
  readonly dataAccess: DataAccessFactory;
  readonly connect: ConnectDeps;
  readonly trust: ViewTrustStore;
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
          const opened =
            profile.azureAuth === 'entra'
              ? await openWithPassword(profile, env.connect)
              : await env.connect.open(profile, password);
          await opened.reader.close();
        },
        entraUser: async () => requireUserName(await auth.postgresToken(undefined)),
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
        },
        log,
        sleep,
        // The follow-up logs its own end and failure; nothing waits for it.
        background: (task) => void task,
      });
    }),
  ];
}
