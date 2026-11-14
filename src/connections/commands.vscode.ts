import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import type { ActiveConnection } from '../active-connection.vscode';
import { attachNewLake } from '../azure/attach-lake';
import { looksLikeBlockedIp } from '../azure/blocked-ip';
import type { Register } from '../command.vscode';
import type { ViewTrustStore } from '../data/trust';
import type { DataAccess } from '../data/types';
import { globalValue } from '../catalog/model';
import { userMessageOf } from '../errors';
import { logFailure } from '../log';
import type { Logger } from '../log';
import type { QueryEditors } from '../sql/editor';
import type { QueryHistory } from '../sql/history';
import type { StorageValues } from '../storage/config';
import type { CatalogTree } from '../tree/model';
import type { TreeNode } from '../tree/refs';
import { openForTest, openWithPassword } from './connect';
import type { ConnectDeps } from './connect';
import { certificateFingerprint } from './fingerprint';
import { createWizardUi } from './ports.vscode';
import type { ConnectionProfile } from './profile';
import { setStorageSignInFlow } from './storage-sign-in';
import type { ConnectionStore } from './store';
import { successText, testCatalogAndStorage } from './test';
import { addConnectionFlow, editConnectionFlow, removeConnectionFlow } from './wizard';
import type { WizardDeps } from './wizard';

interface ConnectionCommandEnv {
  readonly tree: CatalogTree;
  readonly store: ConnectionStore;
  readonly view: vscode.TreeView<TreeNode>;
  readonly logger: Logger;
  readonly connect: ConnectDeps;
  /** The access the engine uses to test the storage; the typed password and sign-in values are not stored yet. */
  readonly testAccess: (
    profile: ConnectionProfile,
    password: string | undefined,
    storageValues: StorageValues | undefined,
  ) => Promise<DataAccess>;
  /** Sessions that were opened with the old sign-in of the storage are closed. */
  readonly editors: Pick<QueryEditors, 'closeSessionsOf'>;
  /** The sign-in name of the Microsoft account, which the wizard prefills as the user of an Entra login. */
  readonly entraUser: (tenant: string | undefined) => Promise<string>;
  readonly trust: ViewTrustStore;
  /** A removed connection takes its Query History with it. */
  readonly history: Pick<QueryHistory, 'clear'>;
  readonly active: ActiveConnection;
  /** Ids of the connections that Edit Connection is saving; the change of the setting must not reopen them. */
  readonly editing: Set<string>;
  readonly register: Register;
}

/** Add, edit, remove, test, connect, disconnect and refresh a connection; each failure is logged and shown. */
export function registerConnectionCommands(env: ConnectionCommandEnv): vscode.Disposable[] {
  const { tree, store, view, active, register } = env;
  const ui = createWizardUi();
  // The wizard shows a failure and goes on, so nothing above it logs it; a message that points to the output channel
  // needs an entry there.
  const logged = <T>(what: string, run: () => Promise<T>): Promise<T> => logFailure(env.logger, what, run);
  const wizard: WizardDeps = {
    store,
    certificateFingerprint: (host, port) =>
      logged(`Reading the TLS certificate of ${host}:${port}`, () => certificateFingerprint(host, port)),
    entraUser: (tenant) => logged('Signing in with the Microsoft account', () => env.entraUser(tenant)),
    testConnection: (profile, password, storageValues) =>
      logged(`Testing the connection "${profile.name}"`, () =>
        testCatalogAndStorage({
          open: () => openForTest(profile, password, env.connect),
          access: () => env.testAccess(profile, password, storageValues),
          storage: profile.kind !== 'quack',
        }),
      ),
    dataPathOf: async (profile, password) => {
      const { reader } = await openForTest(profile, password, env.connect);
      try {
        return globalValue(await reader.metadata(), 'data_path');
      } finally {
        await reader.close();
      }
    },
    storageSecretsChanged: (profile) => env.editors.closeSessionsOf(profile.id),
    fileLake: {
      exists: (path) =>
        stat(path).then(
          () => true,
          () => false,
        ),
      create: async (profile, dataPath, storageValues) => {
        // SQLite and DuckDB make the file, not the folder it is in.
        await mkdir(dirname(profile.path), { recursive: true });
        await logged(`Creating a DuckLake for the connection "${profile.name}"`, async () =>
          attachNewLake(await env.testAccess(profile, undefined, storageValues), dataPath, {
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            report: () => undefined,
            log: env.logger,
          }),
        );
      },
    },
  };

  return [
    register('aantje.addConnection', async () => {
      await addConnectionFlow(ui, wizard);
    }),

    register('aantje.editConnection', async (node) => {
      const profile = node && store.get(node.ref.connectionId);
      if (!profile) {
        return;
      }
      env.editing.add(profile.id);
      try {
        // A new password does not change the setting, so the open connection has to be refreshed explicitly.
        if (await editConnectionFlow(ui, profile, wizard)) {
          tree.refresh(node);
        }
      } finally {
        env.editing.delete(profile.id);
      }
    }),

    register('aantje.removeConnection', async (node) => {
      const profile = node && store.get(node.ref.connectionId);
      if (profile && (await removeConnectionFlow(ui, profile, wizard))) {
        // A removed connection must not leave its permission to resolve views, or the SQL it ran, behind.
        await env.trust.revoke(profile);
        await env.history.clear(profile.id);
      }
    }),

    register('aantje.setStorageSignIn', async (node) => {
      const profile = node && store.get(node.ref.connectionId);
      if (!profile) {
        return;
      }
      await setStorageSignInFlow(ui, profile, {
        store,
        afterStored: async () => {
          await env.editors.closeSessionsOf(profile.id);
          tree.refresh(node);
        },
      });
    }),

    register('aantje.testConnection', async (node) => {
      const profile = node && store.get(node.ref.connectionId);
      if (!profile) {
        return;
      }
      try {
        const tested = await ui.withProgress(`Testing connection "${profile.name}"...`, () =>
          testCatalogAndStorage({
            open: () => openWithPassword(profile, env.connect),
            // The password was stored when the open had to ask for it, so the stored one is current.
            access: async () => env.testAccess(profile, await store.password(profile), undefined),
            storage: profile.kind !== 'quack',
          }),
        );
        ui.info(successText(profile.name, tested));
      } catch (error) {
        env.logger.error(`Testing the connection "${profile.name}" failed.`, error);
        ui.error(`Connection test failed: ${userMessageOf(error)}`);
      }
    }),

    register('aantje.connect', async (node) => {
      if (!node) {
        return;
      }
      await tree.connect(node.ref.connectionId);
      active.select(node.ref.connectionId);
      const { status, error } = tree.state(node.ref.connectionId);
      if (status === 'error') {
        const message = `Cannot connect to "${node.label}": ${error ?? 'unknown error'}`;
        const profile = store.get(node.ref.connectionId);
        if (profile && looksLikeBlockedIp(profile, error ?? '')) {
          const allow = 'Allow my IP';
          void Promise.resolve(
            vscode.window.showErrorMessage(
              `${message} Your IP address may be blocked by the firewall of the server.`,
              allow,
            ),
          ).then((choice) =>
            choice === allow ? vscode.commands.executeCommand('aantje.allowMyIp', node) : undefined,
          );
          return;
        }
        void vscode.window.showErrorMessage(message);
        return;
      }
      await view.reveal(node, { expand: true });
    }),

    register('aantje.disconnect', async (node) => {
      if (node) {
        await tree.disconnect(node.ref.connectionId);
      }
    }),

    register('aantje.refresh', (node) => {
      tree.refresh(node);
    }),
  ];
}
