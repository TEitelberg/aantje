import { join } from 'node:path';
import * as vscode from 'vscode';
import { registerActivityCommand } from './activity/commands.vscode';
import { nodeOf, rootOf } from './actions';
import { createActiveConnection } from './active-connection.vscode';
import { createIcebergStores, registerIcebergCommands } from './iceberg/commands.vscode';
import { registerAdvisorCommand } from './advisor/commands.vscode';
import { registerAzureCommands } from './azure/commands.vscode';
import { registerAwsCommands } from './aws/commands.vscode';
import { PendingAwsLakes } from './aws/pending';
import { AwsLakeRegistry, unfinishedDeleteNotice } from './aws/registry';
import { createAzureAuth } from './azure/auth.vscode';
import { createAwsDbToken } from './aws/db-token';
import { PendingLakes } from './azure/pending';
import { LakeRegistry } from './azure/registry';
import { openCatalog } from './catalog/open';
import { commandRegistrar } from './command.vscode';
import type { Register } from './command.vscode';
import { registerCommands } from './commands.vscode';
import { SchemaDocuments } from './compare.vscode';
import { registerConnectionCommands } from './connections/commands.vscode';
import { openWithPassword } from './connections/connect';
import { askPassword, createSecretsPort, createSettingsPort } from './connections/ports.vscode';
import { signsInWithAwsIam } from './connections/profile';
import type { ConnectionProfile } from './connections/profile';
import { useRdsCaBundle } from './connections/rds-ca';
import { ConnectionStore } from './connections/store';
import {
  createDataAccessFactory,
  readDataSettings,
  testAccess as testStorageAccess,
} from './data/access.vscode';
import type { StorageValues } from './storage/config';
import { createDataActions, registerDataCommands } from './data/commands.vscode';
import { S3CredentialStore } from './data/credentials';
import { describeRelation } from './data/engine';
import { resolveViewColumns } from './data/resolve';
import { maxRowsOf, timeoutMsOf } from './data/settings';
import { confirmViews, createTrustStore } from './data/trust.vscode';
import { registerDependenciesCommand } from './dependencies/commands.vscode';
import { resolveChainKeys } from './files/aws-chain';
import { registerFilesCommands } from './files/commands.vscode';
import { createFilesSource } from './files/source';
import { openSqlParser } from './dependencies/parser';
import { registerGenerateScripts } from './generate-scripts/commands.vscode';
import { createGridDeps, GridPanels } from './grid/grid.vscode';
import type { GridDeps } from './grid/grid.vscode';
import { ResultsPanels } from './grid/results.vscode';
import { registerGrowthCommand } from './growth/commands.vscode';
import { registerHealthCommands } from './health-report/commands.vscode';
import { SecretRegistry } from './log';
import type { Logger } from './log';
import { createOutputChannelLogger } from './log.vscode';
import { watchProfiles } from './profile-watch.vscode';
import { registerRestoreCommands } from './restore/commands.vscode';
import { registerSchemaCompare } from './schema-compare/commands.vscode';
import { registerSchemaHistoryCommand } from './schema-history/commands.vscode';
import { reportPanels } from './shell/host.vscode';
import type { ReportHostEnv } from './shell/host.vscode';
import { createReportPair } from './shell/report-pair.vscode';
import type { ReportCommandEnv } from './shell/report-port.vscode';
import type { TableActionEnv } from './shell/table-actions.vscode';
import { registerScriptCommands } from './script-commands.vscode';
import { disposeAll } from './shutdown';
import { registerSnapshotReportCommand } from './snapshot-report/commands.vscode';
import { catalogCache, trustedViewColumns } from './sql/catalog-cache';
import { QueryEditors } from './sql/editor';
import type { ExplorerPort } from './sql/editor';
import { createQueryUi, openForConnection, registerQueryEditor, revealStatement } from './sql/editor.vscode';
import { documentKey, documentOfKey, editorOf } from './sql/glue.vscode';
import { registerLenses } from './sql/lens.vscode';
import { registerRunToFile } from './sql/run-to-file.vscode';
import { openLanguageService } from './sql/language';
import type { LanguageService } from './sql/language';
import { createQueryHistory, registerQueryHistory } from './sql/history.vscode';
import { registerSqlFormatting } from './sql/format.vscode';
import { registerSqlLanguage } from './sql/language.vscode';
import type { ResultsView } from './sql/results';
import { openEditorSession } from './sql/session';
import { registerStatisticsCommand, showStatistics } from './stats/commands.vscode';
import { resolveStorage } from './storage/resolve';
import { statisticsKind } from './stats/kind';
import { registerTimeTravelCommands } from './time-travel.vscode';
import { performanceTips } from './tips/connection';
import { registerMcpServer } from './mcp/mcp.vscode';
import { CatalogTree } from './tree/model';
import { CatalogTreeProvider } from './tree/provider.vscode';
import type { TreeNode } from './tree/refs';

/** What `activate` hands to the extension-host tests. It is not a public API: only a test run gets it. */
export interface ExtensionApi {
  readonly tree: CatalogTree;
  readonly view: vscode.TreeView<TreeNode>;
  readonly editors: QueryEditors;
  /** Where the SQL editor shows its results; a test replaces `current`. */
  readonly results: { current: ResultsView };
  /** The values that the SQL editor last gave its context keys (`aantje.queryEditor`, `aantje.queryHasResults`, ...). */
  readonly contextKeys: ReadonlyMap<string, boolean>;
}

const SYNTAX_CHECK_DEBOUNCE_MS = 400;

interface Running {
  readonly logger: Logger;
  readonly tree: CatalogTree;
  readonly editors: QueryEditors;
  readonly languageService: LanguageService;
}

let running: Running | undefined;

/** The API for the tests of the extension host; any other extension that asks gets nothing. */
export function exportsFor(mode: vscode.ExtensionMode, api: ExtensionApi): ExtensionApi | undefined {
  return mode === vscode.ExtensionMode.Test ? api : undefined;
}

/** Wires the extension in steps; each step pushes what it creates to `context.subscriptions`. */
export function activate(context: vscode.ExtensionContext): ExtensionApi | undefined {
  const secrets = new SecretRegistry();
  const logger = createOutputChannelLogger(secrets);
  context.subscriptions.push(logger);
  const core = createCore(context, secrets, logger);
  const shared: Shared = { logger, register: commandRegistrar(logger), gridDeps: createGridDeps(logger) };
  const sql = createSqlEditors(context, core, shared);
  const explorer = createExplorer(context, core, sql.editors, logger);
  context.subscriptions.push(
    ...registerQueryHistory({
      history: core.history,
      tree: core.catalogTree,
      editors: sql.editors,
      register: shared.register,
    }),
  );
  const env = createCommandEnv(context, core, explorer, sql.editors, shared);
  registerSqlEditing(context, core, sql, shared);
  registerExplorerCommands(context, core, explorer, env, shared);
  context.subscriptions.push(
    ...registerMcpServer(context, core, { ...shared, ...env, ...explorer, secrets }),
  );

  explorer.connection.updateStatus();

  running = { logger, tree: core.catalogTree, editors: sql.editors, languageService: sql.service };
  return exportsFor(context.extensionMode, {
    tree: core.catalogTree,
    view: explorer.view,
    editors: sql.editors,
    results: sql.results,
    contextKeys: sql.contextKeys,
  });
}

/** Closes everything that holds a native resource, even when one close fails. */
export async function deactivate(): Promise<void> {
  const current = running;
  running = undefined;
  if (current) {
    await disposeAll(
      {
        'SQL editors': () => current.editors.dispose(),
        'language service': () => current.languageService.dispose(),
        'catalog tree': () => current.tree.dispose(),
      },
      current.logger,
    );
  }
}

/** What all steps share: one command registrar, and the clipboard and save dialog of the data grid and the results panel. */
interface Shared {
  readonly logger: Logger;
  readonly register: Register;
  readonly gridDeps: GridDeps;
}

type Core = ReturnType<typeof createCore>;
type SqlEditors = ReturnType<typeof createSqlEditors>;
type Explorer = ReturnType<typeof createExplorer>;
type CommandEnv = ReturnType<typeof createCommandEnv>;

// The editors show their runs in the results panel, and the panel asks the editors where a statement is: the panel
// finds the editors through a binding that exists before both and is set right after.
function createSqlEditors(context: vscode.ExtensionContext, core: Core, { logger, gridDeps }: Shared) {
  const { catalogTree: tree } = core;
  const contextKeys = new Map<string, boolean>();
  const setContext = (key: string, value: boolean): void => {
    contextKeys.set(key, value);
    void vscode.commands.executeCommand('setContext', key, value);
  };
  let editors: QueryEditors | undefined = undefined;
  const panels = new ResultsPanels(
    context.extensionUri,
    {
      revealStatement: (key, offset, length) => {
        if (editors) revealStatement(editors, key, offset, length, logger);
      },
      openQuery: (key, text) => {
        const script = text ?? editors?.lastScript(key)?.text;
        const connectionId = editors?.connectionOf(key);
        if (editors && script !== undefined && connectionId) {
          openForConnection(editors, script, connectionId).catch((error: unknown) => {
            logger.error('Opening a new query failed.', error);
          });
        }
      },
      setContext,
    },
    gridDeps,
  );
  context.subscriptions.push({ dispose: () => panels.dispose() });
  const results = { current: panels as ResultsView };
  editors = createQueryEditors(core, results, {
    status: (id) => tree.state(id).status,
    disconnect: (id) => tree.disconnect(id),
    connect: (id) => void tree.connect(id),
    refresh: core.refreshRoot,
  });
  return { editors, results, panels, service: openLanguageService(), contextKeys, setContext };
}

/** The tree view, the connection that commands without a node act on, and the watch on `aantje.connections`. */
function createExplorer(context: vscode.ExtensionContext, core: Core, editors: QueryEditors, logger: Logger) {
  const { store, catalogTree: tree } = core;
  const provider = new CatalogTreeProvider(tree, (l) => core.history.onDidChange(l), context.extensionUri);
  const view = vscode.window.createTreeView('aantje.catalogs', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const connection = createActiveConnection({ store, tree, view });
  const profiles = watchProfiles({ store, tree, view, editors, logger, onChanged: connection.updateStatus });
  context.subscriptions.push(provider, view, connection.disposable, profiles.disposable);
  return { view, connection, profiles, editors };
}

/** What the commands share, built once: the panels, the data actions and the environments of the reports. */
function createCommandEnv(
  context: vscode.ExtensionContext,
  core: Core,
  { view, connection }: Explorer,
  editors: QueryEditors,
  { logger, register, gridDeps }: Shared,
) {
  const { extensionUri } = context;
  const { store, catalogTree: tree, dataAccess } = core;
  const grid = new GridPanels(extensionUri, gridDeps);
  const statisticsPanels = reportPanels({ extensionUri, logger }, statisticsKind);
  const statistics = { tree, connectionName: (id: string) => store.get(id)?.name, panels: statisticsPanels };
  const showTableStatistics: TableActionEnv['showStatistics'] = (target, snapshot) =>
    showStatistics(statistics, target, snapshot);
  const schemaDocuments = new SchemaDocuments();
  const dataActions = createDataActions({
    grid,
    dataAccess,
    openSql: (connectionId, text, attach) => openForConnection(editors, text, connectionId, attach),
    viewsTrusted: (profile) => core.trust.isTrusted(profile),
    confirmViews: core.confirmViewsOf,
  });
  const host: ReportHostEnv = { tree, store, logger, extensionUri, active: connection.active };
  const tableActions: TableActionEnv = {
    tree,
    view,
    openSql: dataActions.openSql,
    showStatistics: showTableStatistics,
  };
  const { storage, properties } = createReportPair(host, tableActions, store);
  // One SQL parser for the commands that parse view SQL and tokenize scripts; it runs nothing and opens on first use.
  const parser = openSqlParser();
  context.subscriptions.push(
    { dispose: () => grid.dispose() },
    { dispose: () => statisticsPanels.dispose() },
    properties,
    storage,
    schemaDocuments,
    {
      dispose: () =>
        void parser
          .dispose()
          .catch((error: unknown) => logger.error('Closing the SQL parser failed.', error)),
    },
  );
  const reports: ReportCommandEnv = { ...host, actions: dataActions, schemaDocuments, register };
  return {
    statistics,
    showTableStatistics,
    schemaDocuments,
    dataActions,
    tableActions,
    storage,
    properties,
    reports,
    parser,
  };
}

/**
 * The language features and the commands of the SQL editor. Completion reads the catalog that the tree has open, at
 * its newest snapshot, which the SQL session queries too, whatever snapshot the tree shows. It binds a view for its
 * columns only once the connection's views are trusted.
 */
function registerSqlEditing(
  context: vscode.ExtensionContext,
  core: Core,
  { editors, service, panels, setContext }: SqlEditors,
  { logger, register }: Shared,
): void {
  const { store, catalogTree: tree } = core;
  const tipsFor = performanceTips(core, logger);
  const catalogs = catalogCache({
    reader: (id) => tree.reader(id),
    snapshot: (id) => tree.state(id).latestSnapshot,
    views: trustedViewColumns({
      store,
      trust: core.trust,
      dataAccess: core.quietAccess,
      describe: describeRelation,
      log: logger,
    }),
  });
  const connectionChanged = new vscode.EventEmitter<vscode.TextDocument>();
  const connectionOf = (document: vscode.TextDocument): string | undefined =>
    editors.connectionOf(documentKey(document));
  context.subscriptions.push(
    connectionChanged,
    { dispose: () => catalogs.invalidate() },
    tree.onDidChange(() => catalogs.invalidate()),
    editors.onDidChange(({ key, association }) => {
      const document = documentOfKey(key);
      if (association && document) connectionChanged.fire(document);
    }),
    registerSqlLanguage({
      service,
      logger,
      connectionOf,
      catalogOf: (document) => {
        const id = connectionOf(document);
        return id === undefined ? undefined : catalogs.of(id);
      },
      debounceMs: SYNTAX_CHECK_DEBOUNCE_MS,
      onDidChangeConnection: connectionChanged.event,
      onDidChangeCatalog: (listener) => tree.onDidChange(() => void listener(undefined)),
    }),
    ...registerQueryEditor({
      editors,
      tree,
      store,
      logger,
      register,
      setContext,
      results: panels,
    }),
    ...registerLenses({ editors, service, logger, editorOf, connectionOf, tipsFor }),
    registerRunToFile({ editors, service, logger, editorOf }),
    ...registerSqlFormatting({ service, logger, connectionOf }),
  );
}

/** The commands of the tree, of its data and of the reports. */
function registerExplorerCommands(
  context: vscode.ExtensionContext,
  core: Core,
  { view, connection, profiles, editors }: Explorer,
  env: CommandEnv,
  { logger, register }: Shared,
): void {
  const { store, catalogTree: tree, trust, credentials } = core;
  context.subscriptions.push(
    ...registerConnectionCommands({
      tree,
      store,
      view,
      logger,
      connect: core.connect,
      testAccess: core.testAccess,
      editors,
      entraUser: (tenant) => core.azureAuth.entraUser(tenant),
      trust,
      history: core.history,
      icebergCopies: core.iceberg.copies,
      active: connection.active,
      editing: profiles.editing,
      register,
    }),
    ...registerCommands({
      tree,
      store,
      view,
      properties: env.properties,
      storage: env.storage,
      active: connection.active,
      register,
    }),
    ...registerTimeTravelCommands({
      tree,
      store,
      active: connection.active,
      schemaDocuments: env.schemaDocuments,
      register,
    }),
    ...registerDataCommands({
      tree,
      store,
      actions: env.dataActions,
      credentials,
      trust,
      confirmViews: core.confirmViewsOf,
      tokenize: (text) => env.parser.tokenize(text),
      register,
    }),
    ...registerIcebergCommands({ ...env.reports, ...core.iceberg, dataAccess: core.dataAccess }),
    ...registerAzureCommands({
      store,
      view,
      registry: core.lakes,
      pending: core.pendingLakes,
      auth: core.azureAuth,
      dataAccess: core.dataAccess,
      connect: core.connect,
      trust,
      history: core.history,
      register,
      logger,
    }),
    ...registerAwsCommands({
      extensionPath: context.extensionPath,
      store,
      view,
      registry: core.awsLakes,
      pending: core.pendingAwsLakes,
      dataAccess: core.dataAccess,
      connect: core.connect,
      trust,
      history: core.history,
      register,
      logger,
    }),
    ...registerStatisticsCommand({ ...env.statistics, register }),
    ...registerReportCommands(core, view, env),
    ...registerSchemaCompare({
      tree,
      store,
      active: connection.active,
      schemaDocuments: env.schemaDocuments,
      actions: env.dataActions,
      keys: context.globalState,
      logger,
      register,
      parser: env.parser,
    }),
    ...registerGenerateScripts({
      tree,
      openSql: env.dataActions.openSql,
      logger,
      register,
      parser: env.parser,
    }),
    ...registerRestoreCommands({ tree, openSql: env.dataActions.openSql, register, parser: env.parser }),
    ...registerScriptCommands({ tree, openSql: env.dataActions.openSql, register }),
    ...registerFilesCommands({ tree, openSql: env.dataActions.openSql, register }),
    // The details page of aantje in the Extensions view: README, features, changelog and version.
    register('aantje.showInfo', async () => {
      await vscode.commands.executeCommand('extension.open', context.extension.id);
    }),
  );
}

function registerReportCommands(
  core: Core,
  view: vscode.TreeView<TreeNode>,
  env: CommandEnv,
): vscode.Disposable[] {
  const { reports, tableActions, storage } = env;
  const { dataAccess, credentials } = core;
  return [
    ...registerSnapshotReportCommand(reports),
    ...registerActivityCommand(reports),
    ...registerSchemaHistoryCommand(reports),
    ...registerGrowthCommand(reports),
    ...registerDependenciesCommand({
      ...reports,
      view,
      showStatistics: env.showTableStatistics,
      parser: env.parser,
    }),
    ...registerHealthCommands({ ...reports, ...tableActions, env: process.env, dataAccess, credentials }),
    ...registerAdvisorCommand({
      ...reports,
      ...tableActions,
      dataAccess,
      showStorage: (profile, scope) => storage.show(profile, scope),
      checkHealth: async (connectionId, schemaId) => {
        const node = await nodeOf(reports.tree, connectionId, schemaId);
        await vscode.commands.executeCommand('aantje.checkHealth', node);
      },
    }),
  ];
}

function createCore(context: vscode.ExtensionContext, secrets: SecretRegistry, logger: Logger) {
  const store = new ConnectionStore(createSettingsPort(), createSecretsPort(context.secrets), (password) =>
    secrets.add(password),
  );
  const wasmPath = join(context.extensionPath, 'dist', 'sql-wasm.wasm');
  useRdsCaBundle(join(context.extensionPath, 'dist', 'rds-ca-bundle.pem'));

  const azureAuth = createAzureAuth((value) => secrets.add(value));
  const awsDbToken = createAwsDbToken(join(context.extensionPath, 'dist', 'aws-sdk.js'), (value) =>
    secrets.add(value),
  );
  const signIn = { ...azureAuth, awsDbToken };
  const connect = {
    store,
    open: (profile: ConnectionProfile, password: string | undefined) =>
      openCatalog(profile, {
        password,
        wasmPath,
        statementTimeoutMs: queryTimeoutMs(),
        extensionDirectory: readDataSettings().extensionDirectory,
      }),
    askPassword,
    signInToken: (profile: ConnectionProfile) =>
      signsInWithAwsIam(profile)
        ? awsDbToken(profile)
        : azureAuth.postgresToken(profile.kind === 'postgres' ? profile.azureTenant : undefined),
  };
  const credentials = new S3CredentialStore(createSecretsPort(context.secrets), (value) =>
    secrets.add(value),
  );
  const trust = createTrustStore(context.globalState, logger);
  const confirmViewsOf = confirmViews(trust);
  const accessWith = (stored: Parameters<typeof createDataAccessFactory>[2], silent = false) =>
    createDataAccessFactory(store, credentials, stored, queryTimeoutMs, logger, signIn, { silent });
  const dataAccess = accessWith(store.storage);
  // Completion reads view columns while the user types: this access never shows a sign-in.
  const quietAccess = accessWith(store.storage, true);
  // The wizard tests a connection before it is saved: its typed sign-in values replace the stored ones.
  const testAccess = (
    profile: ConnectionProfile,
    password: string | undefined,
    values: StorageValues | undefined,
  ) =>
    testStorageAccess(
      (typed) => accessWith(typed ? { get: () => Promise.resolve(typed) } : store.storage),
      profile,
      password,
      values,
    );
  const iceberg = createIcebergStores(context, secrets, (id) => catalogTree.reader(id), logger);
  const history = createQueryHistory(context.globalState, logger, secrets);
  const pendingLakes = new PendingLakes(context.globalState, createSecretsPort(context.secrets), (value) =>
    secrets.add(value),
  );
  const awsLakes = new AwsLakeRegistry(context.globalState);
  const catalogTree: CatalogTree = new CatalogTree({
    profiles: () => store.list(),
    open: (profile) => openWithPassword(profile, connect),
    // The columns of a view are known only to DuckDB, which runs the SQL stored in the catalog: ask first.
    viewColumns: resolveViewColumns({
      store,
      confirm: confirmViewsOf,
      dataAccess,
      describe: describeRelation,
    }),
    queryHistory: history,
    iceberg: iceberg.statuses,
    // The Files folder lists with the storage of the connection, signed in as the engine is (#20).
    files: createFilesSource({
      storage: (profile) =>
        resolveStorage(profile, {
          settings: readDataSettings().s3,
          credentials,
          stored: store.storage,
          signIn: azureAuth,
        }),
      timeoutMs: queryTimeoutMs,
      chainKeys: (storage) =>
        resolveChainKeys(storage, readDataSettings().extensionDirectory, (value) => secrets.add(value)),
      // The client secrets, assertions and tokens of the Azure sign-ins that the folder fetches itself.
      register: (value) => secrets.add(value),
    }),
    // An AWS lake whose delete did not finish says so in every status (#83).
    notices: {
      of: (id) => {
        const deleting = awsLakes.unfinishedDelete(id);
        return deleting && unfinishedDeleteNotice(deleting);
      },
      onDidChange: (listener) => awsLakes.onDidChange(listener),
    },
    logger,
  });
  const refreshRoot = (connectionId: string): void => {
    const node = rootOf(catalogTree, connectionId);
    if (node) catalogTree.refresh(node);
  };
  // Trusting through another path (Select Top 1000 Rows on a view) leaves the Columns folder with the refusal.
  context.subscriptions.push(trust.onDidTrust((profile) => refreshRoot(profile.id)));
  return {
    store,
    connect,
    testAccess,
    credentials,
    trust,
    confirmViewsOf,
    dataAccess,
    quietAccess,
    catalogTree,
    refreshRoot,
    azureAuth,
    lakes: new LakeRegistry(context.globalState),
    pendingLakes,
    awsLakes,
    pendingAwsLakes: new PendingAwsLakes(context.globalState, createSecretsPort(context.secrets), (value) =>
      secrets.add(value),
    ),
    history,
    iceberg,
  };
}

function createQueryEditors(
  { store, dataAccess, history }: Pick<Core, 'store' | 'dataAccess' | 'history'>,
  results: { current: ResultsView },
  explorer: ExplorerPort,
): QueryEditors {
  return new QueryEditors({
    profiles: { list: () => store.list(), get: (id) => store.get(id) },
    openSession: (...args) => openEditorSession(dataAccess, ...args),
    results: {
      begin: (target, script) => results.current.begin(target, script),
      event: (target, event) => results.current.event(target, event),
      end: (target, summary) => results.current.end(target, summary),
      reveal: (target) => results.current.reveal(target),
    },
    explorer,
    ui: createQueryUi(),
    maxRows: () => maxRowsOf(vscode.workspace.getConfiguration('aantje').get<unknown>('sql.maxRows')),
    history,
  });
}

function queryTimeoutMs(): number {
  return timeoutMsOf(vscode.workspace.getConfiguration('aantje').get<unknown>('queryTimeoutSeconds'));
}
