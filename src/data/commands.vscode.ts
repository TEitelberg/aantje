import type * as vscode from 'vscode';
import { catalogAt, shownSnapshot } from '../actions';
import type { Register } from '../command.vscode';
import type { SnapshotId } from '../catalog/model';
import { effectiveStorage, validateRequired } from '../connections/profile';
import type { ConnectionProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import { createWizardUi } from '../connections/ports.vscode';
import type { GridPanels } from '../grid/grid.vscode';
import { buildNotebook } from '../notebook/build';
import { openNotebook } from '../notebook/open.vscode';
import { timeTravelUi } from '../pick.vscode';
import { withCancel } from '../progress.vscode';
import { selectAtSnapshot } from '../script';
import { changesOfSnapshot, chooseChanges, chooseQuery, subjectOf } from '../time-travel';
import type { ChangeChoice } from '../time-travel';
import type { CatalogTree } from '../tree/model';
import { readDataSettings } from './access.vscode';
import { readTrusting } from './confirm';
import type { S3CredentialStore } from './credentials';
import { checkRelation, previewTable, readChanges } from './engine';
import { changesKey, changesTitle, gridKey, gridTitle } from './relation';
import { resolveTarget } from './resolve';
import type { DataAccessFactory, DataTarget } from './resolve';
import type { ViewTrustStore } from './trust';

/** What the data commands do once they know their target; the snapshot report calls them without a tree node. */
export interface DataActions {
  /** Shows the first rows of the relation at the snapshot (undefined: the latest) in its grid. */
  readonly showRows: (target: DataTarget, snapshot: SnapshotId | undefined) => Promise<void>;
  /** Shows the changes of a table in the grid of that table and range, cancellable. */
  readonly showChanges: (
    target: Pick<DataTarget, 'relation' | 'profile'>,
    range: Pick<ChangeChoice, 'from' | 'to'>,
  ) => Promise<void>;
  /** Creates a notebook; `pinned` undefined follows the latest snapshot, `shown` is the tree's snapshot. */
  readonly createNotebook: (
    target: DataTarget,
    pinned: SnapshotId | undefined,
    shown: SnapshotId | undefined,
  ) => Promise<void>;
  /** Opens the text in an untitled SQL document of the connection without running it. */
  readonly openSql: (connectionId: string, text: string) => Promise<void>;
}

interface DataActionsEnv {
  readonly grid: GridPanels;
  readonly dataAccess: DataAccessFactory;
  readonly openSql: DataActions['openSql'];
  /** Whether the user has confirmed trust in a connection's views; the read passes it to the guard. */
  readonly viewsTrusted: (profile: ConnectionProfile) => boolean;
  /** Asks to trust the connection's views (records it) or throws `ABORTED`; used to retry a refused view read. */
  readonly confirmViews: (profile: ConnectionProfile) => Promise<void>;
}

export function createDataActions(env: DataActionsEnv): DataActions {
  const trusting = <T>(profile: ConnectionProfile, read: (trusted: boolean) => Promise<T>): Promise<T> =>
    readTrusting(profile, env, read);

  const accessFor = async (
    profile: ConnectionProfile,
    snapshot: SnapshotId | undefined,
    trusted: boolean,
  ) => ({
    ...(await env.dataAccess(profile, snapshot)),
    viewsTrusted: trusted,
  });

  const showRows: DataActions['showRows'] = async ({ relation, profile }, snapshot) => {
    const name = `${relation.table.schema}.${relation.table.table}`;
    const data = await trusting(profile, (trusted) =>
      withCancel(`Reading ${name}...`, async (signal) =>
        previewTable(await accessFor(profile, snapshot, trusted), relation.table, signal),
      ),
    );
    env.grid.show(gridKey(relation, snapshot), gridTitle(relation, profile.name, snapshot, data.limit), data);
  };

  const showChanges: DataActions['showChanges'] = async ({ relation, profile }, range) => {
    const name = `${relation.table.schema}.${relation.table.table}`;
    const { data } = await trusting(profile, (trusted) =>
      withCancel(`Reading the changes of ${name}...`, async (signal) =>
        // The latest snapshot is attached: the range may end after the one the tree shows.
        readChanges(await accessFor(profile, undefined, trusted), relation.table, range, signal),
      ),
    );
    env.grid.show(changesKey(relation, range), changesTitle(relation, profile.name, range), data);
  };

  const createNotebook: DataActions['createNotebook'] = async ({ relation, profile }, pinned, shown) => {
    const { s3, extensionDirectory } = readDataSettings();
    // The guard of the preview runs first: the notebook hands the relation to the Python kernel of the user, which would
    // run a view that calls the maintenance functions of DuckLake, or read a name that two relations share.
    const name = `${relation.table.schema}.${relation.table.table}`;
    await trusting(profile, (trusted) =>
      withCancel(`Checking ${name}...`, async (signal) =>
        checkRelation(await accessFor(profile, pinned, trusted), relation.table, signal),
      ),
    );
    await openNotebook(
      buildNotebook({
        connectionName: profile.name,
        profile,
        table: relation.table,
        snapshot: pinned,
        shownSnapshot: shown,
        s3,
        storage: effectiveStorage(profile),
        extensionDirectory,
        generatedOn: new Date().toISOString().slice(0, 10),
      }),
    );
  };

  return { showRows, showChanges, createNotebook, openSql: env.openSql };
}

interface DataCommandEnv {
  readonly tree: CatalogTree;
  readonly store: ConnectionStore;
  readonly actions: DataActions;
  readonly credentials: S3CredentialStore;
  readonly trust: ViewTrustStore;
  readonly confirmViews: (profile: ConnectionProfile) => Promise<void>;
  readonly register: Register;
}

/** Registers the commands that read table data: the Top 1000 grid, the notebook and the S3 credentials. */
export function registerDataCommands(env: DataCommandEnv): vscode.Disposable[] {
  const { tree, store, register } = env;
  const ui = createWizardUi();

  const target = resolveTarget({
    store,
    confirm: env.confirmViews,
    state: (connectionId) => tree.state(connectionId),
  });

  const { showRows, showChanges, createNotebook, openSql } = env.actions;

  return [
    register('aantje.previewTable', async (node) => {
      const found = await target(node);
      if (found) {
        await showRows(found, shownSnapshot(found.state));
      }
    }),

    register('aantje.createNotebook', async (node) => {
      const found = await target(node);
      if (found) {
        const { state } = found;
        // A pinned snapshot is kept; a tree following the latest snapshot yields a notebook that follows it.
        await createNotebook(
          found,
          state.snapshot === 'latest' ? undefined : state.snapshot,
          shownSnapshot(state),
        );
      }
    }),

    register('aantje.queryAtSnapshot', async (node) => {
      const subject = node && subjectOf(node.ref);
      if (!node || !subject) {
        return;
      }
      const { connectionId } = node.ref;
      const { reader, snapshot } = catalogAt(tree, connectionId, 'query at a snapshot');
      // Ask first: trusting a connection's views reloads the tree and closes this reader.
      const choice = await chooseQuery(timeTravelUi, reader, subject, snapshot);
      if (choice?.action === 'sql') {
        // The statement only names the relation, so a view needs no trust.
        await openSql(connectionId, await selectAtSnapshot(reader, subject, choice.table, choice.snapshot));
        return;
      }
      const found = choice && (await target(node));
      if (!choice || !found) {
        return;
      }
      const relation = { ...found.relation, table: choice.table };
      if (choice.action === 'rows') {
        await showRows({ ...found, relation }, choice.snapshot);
      } else {
        await createNotebook({ ...found, relation }, choice.snapshot, choice.snapshot);
      }
    }),

    register('aantje.showChanges', async (node) => {
      const subject = node && subjectOf(node.ref);
      if (!node || subject?.kind !== 'table') {
        return;
      }
      const { connectionId } = node.ref;
      const { reader, snapshot } = catalogAt(tree, connectionId, 'show its changes');
      const choice = await chooseChanges(timeTravelUi, reader, subject, snapshot);
      const found = choice && (await target(node));
      if (choice && found) {
        await showChanges({ ...found, relation: { ...found.relation, table: choice.table } }, choice);
      }
    }),

    register('aantje.showSnapshotChanges', async (node) => {
      const change = node?.ref.kind === 'detail' ? node.ref.change : undefined;
      const profile = node && store.get(node.ref.connectionId);
      if (!change || !profile) {
        return;
      }
      const choice = await changesOfSnapshot(
        timeTravelUi,
        catalogAt(tree, profile.id, 'show the rows of a snapshot').reader,
        change,
      );
      if (choice) {
        await showChanges(
          { profile, relation: { connectionId: profile.id, kind: 'table', table: choice.table } },
          choice,
        );
      }
    }),

    register('aantje.setS3Credentials', async () => {
      const keyId = await ui.input({
        title: 'Set S3 Credentials (1/2)',
        prompt: 'Access key id for the S3 storage that holds the data of the catalogs',
        validate: validateRequired('Access key id'),
      });
      if (keyId === undefined) {
        return;
      }
      const secretKey = await ui.input({
        title: 'Set S3 Credentials (2/2)',
        prompt: 'Secret access key. It is kept in the secret storage, not in the settings.',
        password: true,
        validate: validateRequired('Secret access key'),
      });
      if (secretKey === undefined) {
        return;
      }
      // Trim the key id only (a pasted space); the secret is stored as typed.
      await env.credentials.set({ keyId: keyId.trim(), secretKey });
      ui.info('The S3 credentials are stored in the secret storage.');
    }),

    register('aantje.clearS3Credentials', async () => {
      await env.credentials.clear();
      ui.info(
        'The stored S3 credentials were removed. Credentials from the environment, if any, still apply.',
      );
    }),

    register('aantje.revokeViewTrust', async () => {
      await env.trust.revokeAll();
      ui.info('aantje asks again before it resolves the views of a connection.');
    }),
  ];
}
