import * as vscode from 'vscode';
import type { ActiveConnection } from './active-connection.vscode';
import { ddlOf, findEntryNode, qualifiedNameOf, shownSnapshot } from './actions';
import { showConnectFirst } from './command.vscode';
import type { Register } from './command.vscode';
import type { CatalogInfo } from './catalog/model';
import type { OpenedCatalog } from './catalog/open';
import { openWithPassword } from './connections/connect';
import type { ConnectDeps } from './connections/connect';
import { certificateFingerprint } from './connections/fingerprint';
import { createWizardUi } from './connections/ports.vscode';
import type { ConnectionStore } from './connections/store';
import { addConnectionFlow, editConnectionFlow, removeConnectionFlow } from './connections/wizard';
import type { WizardDeps } from './connections/wizard';
import { compareSchema, snapshotsReport } from './compare';
import { looksLikeBlockedIp } from './azure/blocked-ip';
import type { SchemaDocuments } from './compare.vscode';
import type { ViewTrustStore } from './data/trust';
import { userMessageOf } from './errors';
import { logFailure } from './log';
import type { Logger } from './log';
import { pickOne, timeTravelUi } from './pick.vscode';
import { connectionClosed, withoutIcons } from './messages';
import type { PropertiesReport } from './properties-report/model';
import { openMarkdown } from './shell/host.vscode';
import { searchPickItems } from './search';
import { snapshotChoices, snapshotPickItems } from './snapshot';
import { LAKE_SCOPE, scopeOfNode } from './shell/scope';
import type { StorageReport } from './storage-report/model';
import { choosePair, chooseRange, subjectOf } from './time-travel';
import type { CatalogTree } from './tree/model';
import type { TreeNode } from './tree/refs';

interface CommandEnv {
  readonly tree: CatalogTree;
  readonly store: ConnectionStore;
  readonly view: vscode.TreeView<TreeNode>;
  readonly logger: Logger;
  readonly connect: ConnectDeps;
  /** The sign-in name of the Microsoft account, which the wizard prefills as the user of an Entra login. */
  readonly entraUser: (tenant: string | undefined) => Promise<string>;
  readonly trust: ViewTrustStore;
  readonly properties: PropertiesReport;
  readonly storage: StorageReport;
  /** The documents of the schema diff; the snapshot report shows them too. */
  readonly schemaDocuments: SchemaDocuments;
  readonly active: ActiveConnection;
  /** Ids of the connections that Edit Connection is saving; the change of the setting must not reopen them. */
  readonly editing: Set<string>;
  readonly register: Register;
}

/** Registers all commands of the explorer; each failure is logged and shown as a message. */
export function registerCommands(env: CommandEnv): vscode.Disposable[] {
  return [...registerConnectionCommands(env), ...registerNavigationCommands(env)];
}

function registerConnectionCommands(env: CommandEnv): vscode.Disposable[] {
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
    // An Entra login has no password to test with: the connection asks for a token.
    testConnection: (profile, password) =>
      logged(`Testing the connection "${profile.name}"`, () =>
        infoOf(() =>
          profile.kind === 'postgres' && profile.azureAuth === 'entra'
            ? openWithPassword(profile, env.connect)
            : env.connect.open(profile, password),
        ),
      ),
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
        // A removed connection must not leave its permission to resolve views behind.
        await env.trust.revoke(profile);
      }
    }),

    register('aantje.testConnection', async (node) => {
      const profile = node && store.get(node.ref.connectionId);
      if (!profile) {
        return;
      }
      try {
        const info = await ui.withProgress(`Testing connection "${profile.name}"...`, () =>
          infoOf(() => openWithPassword(profile, env.connect)),
        );
        ui.info(
          `The connection "${profile.name}" works. DuckLake spec version ${info.specVersion}, latest snapshot ${info.latestSnapshot}.`,
        );
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

function registerNavigationCommands(env: CommandEnv): vscode.Disposable[] {
  const { tree, store, view, active, schemaDocuments, register } = env;

  const copy = async (text: string, what: string): Promise<void> => {
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`Copied ${withoutIcons(what)}`, 3000);
  };

  /** The connected connection a node-less command acts on, or a hint when there is none. */
  const connected = (node: TreeNode | undefined, goal: string) => {
    const profile = node ? store.get(node.ref.connectionId) : active.current();
    const reader = profile && tree.reader(profile.id);
    const state = profile && tree.state(profile.id);
    const snapshot = state && shownSnapshot(state);
    if (!profile || !reader || !state || snapshot === undefined) {
      showConnectFirst(goal);
      return undefined;
    }
    return { profile, reader, state, snapshot };
  };

  /** The reader and the shown snapshot behind a table node; a closed connection is an error, like for Script as. */
  const tableOf = (node: TreeNode | undefined, goal: string) => {
    const subject = node && subjectOf(node.ref);
    if (!node || subject?.kind !== 'table') {
      return undefined;
    }
    const { connectionId } = node.ref;
    const reader = tree.reader(connectionId);
    if (!reader) {
      throw connectionClosed(goal);
    }
    return { reader, subject, connectionId, shown: shownSnapshot(tree.state(connectionId)) };
  };

  return [
    register('aantje.copyName', async (node) => {
      const name = node && qualifiedNameOf(node.ref);
      if (name !== undefined) {
        await copy(name, name);
      }
    }),

    register('aantje.copyDdl', async (node) => {
      const ddl = node ? await ddlOf(tree, node.ref) : undefined;
      if (node && ddl !== undefined) {
        await copy(ddl, `the DDL of ${node.label}`);
      }
    }),

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

    register('aantje.showProperties', async (node) => {
      const target = connected(node, 'show its properties');
      if (target) {
        await env.properties.show(target.profile);
      }
    }),

    register('aantje.showStorage', async (node) => {
      const target = connected(node, 'show its storage');
      if (target) {
        await env.storage.show(target.profile, (node && scopeOfNode(node.ref)) ?? LAKE_SCOPE);
      }
    }),

    register('aantje.search', async () => {
      const target = connected(undefined, 'search it');
      if (!target) {
        return;
      }
      const items = searchPickItems(await target.reader.entries(target.snapshot));
      const choice = await pickOne(items, {
        title: `Search "${target.profile.name}"`,
        placeholder: 'Type the name of a table or view',
      });
      const node = choice && (await findEntryNode(tree, target.profile.id, choice.value));
      if (node) {
        await view.reveal(node, { select: true, focus: true });
      }
    }),
  ];
}

async function infoOf(open: () => Promise<OpenedCatalog>): Promise<CatalogInfo> {
  const { reader, info } = await open();
  await reader.close();
  return info;
}
