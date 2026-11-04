import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ActiveConnection } from '../active-connection.vscode';
import { guarded, showConnectFirst } from '../command.vscode';
import type { CatalogReader } from '../catalog/model';
import type { ConnectionProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import { gridHtml } from '../grid/html';
import type { Logger } from '../log';
import { withCancel } from '../progress.vscode';
import type { CatalogTree } from '../tree/model';
import { ReportPanels } from './panels';
import type { PanelFactory, PanelHandlers, ReportKind } from './panels';

/** What every report needs from the extension. */
export interface ReportHostEnv {
  readonly tree: CatalogTree;
  readonly store: ConnectionStore;
  readonly logger: Logger;
  readonly extensionUri: vscode.Uri;
  readonly active: Pick<ActiveConnection, 'select'>;
}

interface PanelSpec {
  readonly viewType: string;
  readonly title: string;
  /** The page script in `dist`. */
  readonly script: 'grid-client.js' | 'report-client.js';
  readonly column: Parameters<typeof vscode.window.createWebviewPanel>[2];
  /** The stylesheet of the page; the grid's own one when absent. */
  readonly css?: string;
}

/** A panel whose page runs one script of `dist` under a fresh nonce; it may load resources from `dist` only. */
export function createPanel(extensionUri: vscode.Uri, spec: PanelSpec): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(spec.viewType, spec.title, spec.column, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
  });
  panel.webview.html = gridHtml({
    nonce: randomBytes(16).toString('base64'),
    scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', spec.script)).toString(),
    title: spec.title,
    css: spec.css,
  });
  return panel;
}

function webviewPanels(extensionUri: vscode.Uri): PanelFactory {
  return (kind, title) => {
    const panel = createPanel(extensionUri, {
      viewType: kind.viewType,
      title,
      script: 'report-client.js',
      column: vscode.ViewColumn.Active,
      css: kind.css,
    });
    return {
      setTitle: (next) => void (panel.title = next),
      reveal: () => panel.reveal(),
      post: (message) => void panel.webview.postMessage(message),
      dispose: () => void panel.dispose(),
      onMessage: (listener) => void panel.webview.onDidReceiveMessage(listener),
      onDispose: (listener) => void panel.onDidDispose(listener),
    };
  };
}

/** Opens the text in an untitled Markdown document. */
export async function openMarkdown(markdown: string): Promise<void> {
  await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown }),
  );
}

/** The panels of one report kind; Open as Markdown opens an untitled document. */
export function reportPanels<Data, Action, View>(
  env: Pick<ReportHostEnv, 'extensionUri' | 'logger'>,
  kind: ReportKind<Data, Action, View>,
  handlers: Omit<PanelHandlers<Data, Action>, 'openMarkdown'> = {},
): ReportPanels<Data, Action, View> {
  return new ReportPanels(webviewPanels(env.extensionUri), kind, {
    ...handlers,
    openMarkdown: (markdown) =>
      void openMarkdown(markdown).catch((error: unknown) => {
        env.logger.error('Opening the report as Markdown failed.', error);
      }),
  });
}

/** The panel's connection, or a hint when it was removed while the panel stayed open. */
export function profileOf(
  store: Pick<ConnectionStore, 'get'>,
  connectionId: string,
  what: string,
): ConnectionProfile | undefined {
  const profile = store.get(connectionId);
  if (!profile) {
    void vscode.window.showInformationMessage(
      `The connection of this ${what} was removed. Close the report.`,
    );
  }
  return profile;
}

interface Reading<Data> {
  readonly progress: string;
  /** Null when the subject does not exist at the snapshot: then `absent` is shown, and no panel. */
  readonly read: (signal: AbortSignal) => Promise<Data | null>;
  readonly title: (data: Data) => string;
  readonly absent?: string;
}

export interface ReportSpec<Data, Action, View, Plan, Params extends object> {
  /** The command that opens the report; a failed Refresh or action is reported against it. */
  readonly command: string;
  readonly kind: ReportKind<Data, Action, View>;
  /** The report's name in messages: "growth report". */
  readonly noun: string;
  /** Completes "Connect to a catalog first to ...". */
  readonly goal: string;
  /** The panel key: the connection plus the report's subject. */
  readonly keyOf: (profile: ConnectionProfile, params: Params) => string;
  /** The read for a connected connection; undefined when another input it needs is missing. */
  readonly open: (
    reader: CatalogReader,
    profile: ConnectionProfile,
    params: Params,
  ) => Reading<Data> | undefined;
  readonly planAction: (data: Data, action: Action) => Plan | undefined;
  readonly perform: (plan: Plan, profile: ConnectionProfile, data: Data) => Promise<void>;
  /** The parameters of a Refresh; by default those the panel was opened with. */
  readonly refreshParams?: (params: Params) => Params;
}

interface OpenedReport<Params extends object> {
  /** Reads the report under a cancellable progress and shows it in its panel. */
  show(profile: ConnectionProfile, params: Params): Promise<void>;
  dispose(): void;
}

/**
 * A refresh of the explorer, also after a statement of the SQL editor changed the lake, leaves the numbers of an open
 * panel behind: the panels that `keysOf` names for the refreshed connection are marked out of date until new data
 * arrives. A report whose panels do not go through `openReport` calls this itself.
 */
export function markStaleOnRefresh(
  tree: Pick<CatalogTree, 'onDidRefresh'>,
  panels: { markStale(key: string): void },
  keysOf: (connectionId: string) => Iterable<string>,
): { dispose(): void } {
  return tree.onDidRefresh((connectionId) => {
    for (const key of keysOf(connectionId)) panels.markStale(key);
  });
}

/** Panels of a per-connection report; the page is untrusted, so actions are planned against the data that was sent. */
export function openReport<Data, Action, View, Plan, Params extends object>(
  env: ReportHostEnv,
  spec: ReportSpec<Data, Action, View, Plan, Params>,
): OpenedReport<Params> {
  const { store, logger, active } = env;
  // The connection and parameters of each open panel, for refresh and actions.
  const opened = new Map<string, { readonly connectionId: string; readonly params: Params }>();

  async function show(profile: ConnectionProfile, params: Params): Promise<void> {
    const reader = env.tree.reader(profile.id);
    const reading = reader && spec.open(reader, profile, params);
    if (!reading) {
      showConnectFirst(spec.goal);
      return;
    }
    const key = spec.keyOf(profile, params);
    const data = await panels.read(key, (outer) => withCancel(reading.progress, reading.read, outer));
    if (data === null) {
      if (reading.absent !== undefined) void vscode.window.showInformationMessage(reading.absent);
      return;
    }
    if (data !== undefined) {
      opened.set(key, { connectionId: profile.id, params });
      panels.show(key, reading.title(data), data);
      active.select(profile.id);
    }
  }

  const panels = reportPanels(env, spec.kind, {
    onClose: (key) => opened.delete(key),
    onRefresh: (key) => {
      const panel = opened.get(key);
      const profile = panel && profileOf(store, panel.connectionId, spec.noun);
      if (panel && profile) {
        const params = spec.refreshParams?.(panel.params) ?? panel.params;
        void guarded(logger, spec.command, () => show(profile, params));
      }
    },
    onAction: (message, data, key) => {
      const profile = profileOf(store, opened.get(key)?.connectionId ?? '', spec.noun);
      if (!profile) {
        return;
      }
      const plan = spec.planAction(data, message);
      if (!plan) {
        logger.warn(`The ${spec.noun} asked for an action that its data does not offer; it was ignored.`);
        return;
      }
      void guarded(logger, spec.command, () => spec.perform(plan, profile, data));
    },
  });

  const refreshed = markStaleOnRefresh(env.tree, panels, (connectionId) =>
    [...opened].filter(([, panel]) => panel.connectionId === connectionId).map(([key]) => key),
  );

  return {
    show,
    dispose: () => {
      refreshed.dispose();
      panels.dispose();
    },
  };
}
