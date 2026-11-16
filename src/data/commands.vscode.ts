import type * as vscode from 'vscode';
import { catalogAt, shownSnapshot } from '../actions';
import type { Register } from '../command.vscode';
import type { SnapshotId } from '../catalog/model';
import { effectiveStorage, validateRequired } from '../connections/profile';
import type { ConnectionProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import { createWizardUi } from '../connections/ports.vscode';
import type { Tokenize } from '../ddl-script/check';
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
import { exportToFile } from './export.vscode';
import { scriptInsertData } from './insert-data.vscode';
import { changesKey, changesTitle, gridKey, gridTitle } from './relation';
import { resolveTarget } from './resolve';
import type { DataAccessFactory, DataTarget } from './resolve';
import type { ViewTrustStore } from './trust';
import type { DataAccess, GridData } from './types';
import type { SessionAttachment } from '../sql/editor';

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
  /**
   * Opens the text in an untitled SQL document of the connection without running it; `attach` is a further connection
   * that the session of the document attaches read-only.
   */
  readonly openSql: (connectionId: string, text: string, attach?: SessionAttachment) => Promise<void>;
  /** Shows rows that a command read itself (Data Compare) in the grid panel of `key`. */
  readonly showGrid: (key: string, title: string, data: GridData) => void;
  /** The data access of a connection at the snapshot (undefined: the latest), for an engine with several lakes. */
  readonly accessOf: (profile: ConnectionProfile, snapshot: SnapshotId | undefined) => Promise<DataAccess>;
  /**
   * Runs `read` with the data access of the relation's connection at the snapshot (undefined: the latest), under a
   * notification with Cancel. When the guard finds a view and the connection is not trusted, it asks once and reads
   * again trusted. Export and the other reads of a whole relation use it with `withWholeRelation`.
   */
  readonly read: <T>(
    target: Pick<DataTarget, 'profile'>,
    snapshot: SnapshotId | undefined,
    title: string,
    read: (access: DataAccess, signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
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
  const read: DataActions['read'] = ({ profile }, snapshot, title, run) =>
    readTrusting(profile, env, (trusted) =>
      withCancel(title, async (signal) =>
        run({ ...(await env.dataAccess(profile, snapshot)), viewsTrusted: trusted }, signal),
      ),
    );

  const showRows: DataActions['showRows'] = async (target, snapshot) => {
    const { relation, profile } = target;
    const name = `${relation.table.schema}.${relation.table.table}`;
    const data = await read(target, snapshot, `Reading ${name}...`, (access, signal) =>
      previewTable(access, relation.table, signal),
    );
    env.grid.show(gridKey(relation, snapshot), gridTitle(relation, profile.name, snapshot, data.limit), data);
  };

  const showChanges: DataActions['showChanges'] = async (target, range) => {
    const { relation, profile } = target;
    const name = `${relation.table.schema}.${relation.table.table}`;
    // The latest snapshot is attached: the range may end after the one the tree shows.
    const { data } = await read(target, undefined, `Reading the changes of ${name}...`, (access, signal) =>
      readChanges(access, relation.table, range, signal),
    );
    env.grid.show(changesKey(relation, range), changesTitle(relation, profile.name, range), data);
  };

  const createNotebook: DataActions['createNotebook'] = async (target, pinned, shown) => {
    const { relation, profile } = target;
    const { s3, extensionDirectory } = readDataSettings();
    // The guard of the preview runs first: the notebook hands the relation to the Python kernel of the user, which would
    // run a view that calls the maintenance functions of DuckLake, or read a name that two relations share.
    const name = `${relation.table.schema}.${relation.table.table}`;
    await read(target, pinned, `Checking ${name}...`, (access, signal) =>
      checkRelation(access, relation.table, signal),
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

  return {
    showRows,
    showChanges,
    createNotebook,
    openSql: env.openSql,
    read,
    showGrid: (key, title, data) => env.grid.show(key, title, data),
    accessOf: (profile, snapshot) => env.dataAccess(profile, snapshot),
  };
}

interface DataCommandEnv {
  readonly tree: CatalogTree;
  readonly store: ConnectionStore;
  readonly actions: DataActions;
  readonly credentials: S3CredentialStore;
  readonly trust: ViewTrustStore;
  readonly confirmViews: (profile: ConnectionProfile) => Promise<void>;
  /** DuckDB's tokenizer for the scripts that copy catalog text; it runs nothing. */
  readonly tokenize: Tokenize;
  readonly register: Register;
}

/**
 * Registers the commands that read table data: the Top 1000 grid, Export, Script as INSERT with Data, the notebook and
 * the S3 credentials.
 */
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

    register('aantje.exportRelation', async (node) => {
      const found = await target(node);
      if (found) {
        await exportToFile(env.actions, found, shownSnapshot(found.state));
      }
    }),

    register('aantje.scriptInsertData', async (node) => {
      const found = await target(node);
      if (node && found) {
        await scriptInsertData(
          { actions: env.actions, tree, tokenize: env.tokenize },
          node.ref,
          found,
          shownSnapshot(found.state),
        );
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
