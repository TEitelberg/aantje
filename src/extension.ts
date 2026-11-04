import { join } from 'node:path';
import * as vscode from 'vscode';
import { registerActivityCommand } from './activity/commands.vscode';
import { createActiveConnection } from './active-connection.vscode';
import { registerAdvisorCommand } from './advisor/commands.vscode';
import { registerAzureCommands } from './azure/commands.vscode';
import { createAzureAuth } from './azure/auth.vscode';
import { requireUserName } from './azure/jwt';
import { PendingLakes } from './azure/pending';
import { LakeRegistry } from './azure/registry';
import { openCatalog } from './catalog/open';
import { commandRegistrar } from './command.vscode';
import type { Register } from './command.vscode';
import { registerCommands } from './commands.vscode';
import { SchemaDocuments } from './compare.vscode';
import { openWithPassword } from './connections/connect';
import { createSecretsPort, createSettingsPort } from './connections/ports.vscode';
import { secretLabel } from './connections/profile';
import type { ConnectionProfile } from './connections/profile';
import { ConnectionStore } from './connections/store';
import { createDataAccessFactory, readDataSettings } from './data/access.vscode';
import { createDataActions, registerDataCommands } from './data/commands.vscode';
import { S3CredentialStore } from './data/credentials';
import { describeRelation } from './data/engine';
import { resolveViewColumns } from './data/resolve';
import { maxRowsOf, timeoutMsOf } from './data/settings';
import { confirmViews, createTrustStore } from './data/trust.vscode';
import { registerDependenciesCommand } from './dependencies/commands.vscode';
import { createGridDeps, GridPanels } from './grid/grid.vscode';
import type { GridDeps } from './grid/grid.vscode';
import { ResultsPanels } from './grid/results.vscode';
import { registerGrowthCommand } from './growth/commands.vscode';
import { registerHealthCommands } from './health-report/commands.vscode';
import { SecretRegistry } from './log';
import type { Logger } from './log';
import { createOutputChannelLogger } from './log.vscode';
import { watchProfiles } from './profile-watch.vscode';
import { createPropertiesReport } from './properties-report/commands.vscode';
import type { PropertiesReport } from './properties-report/model';
import { registerSchemaHistoryCommand } from './schema-history/commands.vscode';
import { reportPanels } from './shell/host.vscode';
import type { ReportHostEnv } from './shell/host.vscode';
import type { ReportCommandEnv } from './shell/report-port.vscode';
import type { TableActionEnv } from './shell/table-actions.vscode';
import { disposeAll } from './shutdown';
import { registerSnapshotReportCommand } from './snapshot-report/commands.vscode';
import { catalogCache, QueryEditors, trustedViewColumns } from './sql/editor';
import type { ExplorerPort } from './sql/editor';
import {
  createQueryUi,
  documentKey,
  openForConnection,
  registerQueryEditor,
  revealStatement,
} from './sql/editor.vscode';
import { openLanguageService } from './sql/language';
import type { LanguageService } from './sql/language';
import { registerSqlLanguage } from './sql/language.vscode';
import type { ResultsView } from './sql/results';
import { openSqlSession } from './sql/session';
import { registerStatisticsCommand, showStatistics } from './stats/commands.vscode';
import { statisticsKind } from './stats/kind';
import { createStorageReport } from './storage-report/commands.vscode';
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
  const env = createCommandEnv(context, core, explorer, sql.editors, shared);
  registerSqlEditing(context, core, sql, shared);
  registerExplorerCommands(context, core, explorer, env, shared);
  explorer.profiles.reportProblems();
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
      setContext,
    },
    gridDeps,
  );
  context.subscriptions.push({ dispose: () => panels.dispose() });
  const results = { current: panels as ResultsView };
  editors = createQueryEditors(core.store, core.dataAccess, results, {
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
  const provider = new CatalogTreeProvider(tree);
  const view = vscode.window.createTreeView('aantje.catalogs', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const connection = createActiveConnection({ store, tree, view });
  const profiles = watchProfiles({ store, tree, editors, logger, onChanged: connection.updateStatus });
  context.subscriptions.push(provider, view, connection.disposable, profiles.disposable);
  return { view, connection, profiles };
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
    openSql: (connectionId, text) => openForConnection(editors, text, connectionId),
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
  context.subscriptions.push(
    { dispose: () => grid.dispose() },
    { dispose: () => statisticsPanels.dispose() },
    properties,
    storage,
    schemaDocuments,
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
  };
}

// The Properties report offers a button for the Storage report and the Storage report one for the Properties; the
// Storage report finds the Properties report through a binding that is set right after it.
function createReportPair(host: ReportHostEnv, tableActions: TableActionEnv, store: ConnectionStore) {
  let properties: PropertiesReport | undefined = undefined;
  const storage = createStorageReport({
    ...host,
    ...tableActions,
    showProperties: async (profile) => {
      await properties?.show(profile);
    },
  });
  properties = createPropertiesReport({
    ...host,
    actions: {
      showStorage: async (connectionId) => {
        const profile = store.get(connectionId);
        if (profile) {
          await storage.show(profile);
        }
      },
    },
  });
  return { storage, properties };
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
  const { store, catalogTree: tree, azureAuth } = core;
  // Completion reads view columns while the user types: the access never shows a sign-in.
  const quietAccess = createDataAccessFactory(
    store,
    core.credentials,
    queryTimeoutMs,
    logger,
    (account, tenant) => azureAuth.storageAccess(account, tenant, true),
    (tenant) => azureAuth.postgresToken(tenant, true),
  );
  const catalogs = catalogCache({
    reader: (id) => tree.reader(id),
    snapshot: (id) => tree.state(id).latestSnapshot,
    views: trustedViewColumns({
      store,
      trust: core.trust,
      dataAccess: quietAccess,
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
      const document = vscode.workspace.textDocuments.find((candidate) => documentKey(candidate) === key);
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
      service,
      logger,
      register,
      setContext,
      results: panels,
    }),
  );
}

/** The commands of the tree, of its data and of the reports. */
function registerExplorerCommands(
  context: vscode.ExtensionContext,
  core: Core,
  { view, connection, profiles }: Explorer,
  env: CommandEnv,
  { logger, register }: Shared,
): void {
  const { store, catalogTree: tree, trust, credentials } = core;
  context.subscriptions.push(
    ...registerCommands({
      tree,
      store,
      view,
      logger,
      connect: core.connect,
      entraUser: async (tenant) => requireUserName(await core.azureAuth.postgresToken(tenant)),
      trust,
      properties: env.properties,
      storage: env.storage,
      schemaDocuments: env.schemaDocuments,
      active: connection.active,
      editing: profiles.editing,
      register,
    }),
    ...registerDataCommands({
      tree,
      store,
      actions: env.dataActions,
      credentials,
      trust,
      confirmViews: core.confirmViewsOf,
      register,
    }),
    ...registerAzureCommands({
      store,
      registry: core.lakes,
      pending: core.pendingLakes,
      auth: core.azureAuth,
      dataAccess: core.dataAccess,
      connect: core.connect,
      trust,
      register,
      logger,
    }),
    ...registerStatisticsCommand({ ...env.statistics, register }),
    ...registerReportCommands(core, view, env),
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
    ...registerDependenciesCommand({ ...reports, view, showStatistics: env.showTableStatistics }),
    ...registerHealthCommands({ ...reports, ...tableActions, env: process.env, dataAccess, credentials }),
    ...registerAdvisorCommand({
      ...reports,
      ...tableActions,
      dataAccess,
      showStorage: (profile, scope) => storage.show(profile, scope),
      checkHealth: async (connectionId, schemaId) => {
        const root = reports.tree.roots().find((candidate) => candidate.ref.connectionId === connectionId);
        const node =
          root && schemaId !== undefined
            ? (await reports.tree.children(root)).find(
                (child) => child.ref.kind === 'schema' && child.ref.schema.id === schemaId,
              )
            : root;
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

  const azureAuth = createAzureAuth((value) => secrets.add(value));
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
    entraToken: (profile: ConnectionProfile) =>
      azureAuth.postgresToken(profile.kind === 'postgres' ? profile.azureTenant : undefined),
  };
  const credentials = new S3CredentialStore(createSecretsPort(context.secrets), (value) =>
    secrets.add(value),
  );
  const trust = createTrustStore(context.globalState, logger);
  const confirmViewsOf = confirmViews(trust);
  const dataAccess = createDataAccessFactory(
    store,
    credentials,
    queryTimeoutMs,
    logger,
    (account, tenant) => azureAuth.storageAccess(account, tenant),
    (tenant, silent) => azureAuth.postgresToken(tenant, silent),
  );
  const lakes = new LakeRegistry(context.globalState);
  const pendingLakes = new PendingLakes(context.globalState, createSecretsPort(context.secrets), (value) =>
    secrets.add(value),
  );
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
    logger,
  });
  const refreshRoot = (connectionId: string): void => {
    const node = catalogTree.roots().find((root) => root.ref.connectionId === connectionId);
    if (node) catalogTree.refresh(node);
  };
  // Trusting through another path (Select Top 1000 Rows on a view) leaves the Columns folder with the refusal.
  context.subscriptions.push(trust.onDidTrust((profile) => refreshRoot(profile.id)));
  return {
    store,
    connect,
    credentials,
    trust,
    confirmViewsOf,
    dataAccess,
    catalogTree,
    refreshRoot,
    azureAuth,
    lakes,
    pendingLakes,
  };
}

function createQueryEditors(
  store: ConnectionStore,
  dataAccess: ReturnType<typeof createDataAccessFactory>,
  results: { current: ResultsView },
  explorer: ExplorerPort,
): QueryEditors {
  return new QueryEditors({
    profiles: { list: () => store.list(), get: (id) => store.get(id) },
    openSession: async (profile, mode, signal) =>
      openSqlSession({ access: await dataAccess(profile, undefined), mode, signal }),
    results: {
      begin: (target, script) => results.current.begin(target, script),
      event: (target, event) => results.current.event(target, event),
      end: (target, summary) => results.current.end(target, summary),
      reveal: (target) => results.current.reveal(target),
    },
    explorer,
    ui: createQueryUi(),
    maxRows: () => maxRowsOf(vscode.workspace.getConfiguration('aantje').get<unknown>('sql.maxRows')),
  });
}

function queryTimeoutMs(): number {
  return timeoutMsOf(vscode.workspace.getConfiguration('aantje').get<unknown>('queryTimeoutSeconds'));
}

function askPassword(profile: ConnectionProfile, previousRejected: boolean): Promise<string | undefined> {
  const secret = secretLabel(profile);
  return Promise.resolve(
    vscode.window.showInputBox({
      title: `${secret === 'token' ? 'Token' : 'Password'} for "${profile.name}"`,
      prompt: previousRejected
        ? `The stored ${secret} was rejected. Enter the current ${secret}; it is kept in the secret storage.`
        : `The server asks for a ${secret}. It is kept in the secret storage, not in the settings.`,
      password: true,
      ignoreFocusOut: true,
    }),
  );
}
