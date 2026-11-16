// The VS Code side of aantje's MCP server: it starts and stops the server with `aantje.mcp.enabled`, registers it for
// VS Code's MCP clients (Copilot), writes the window file and the bridge for Claude Code, and offers the command
// that adds the server to Claude Code. Runs the same in Desktop VS Code and in code-server: the server listens on the
// machine of the extension host, where Claude Code runs too.
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { shownSnapshot } from '../actions';
import type { Register } from '../command.vscode';
import type { ConnectionProfile } from '../connections/profile';
import type { DataAccessFactory } from '../data/resolve';
import type { SqlParser, SqlTokenizer } from '../dependencies/parser';
import type { Logger, SecretRegistry } from '../log';
import type { IcebergCopies } from '../iceberg/records';
import type { IcebergStatuses } from '../iceberg/service';
import type { IcebergTargetStore } from '../iceberg/store';
import { REQUEST_SYNC } from '../iceberg/sync-request';
import type { RequestedSync } from '../iceberg/sync-request';
import { whenShown } from '../tree/shown';
import type { ShownView } from '../tree/shown';
import { messageOf } from '../errors';
import {
  leftoverWindowFiles,
  processAlive,
  removeWindowEntry,
  WINDOWS_FOLDER,
  writeWindowEntry,
} from './discovery';
import { createExecuteTools } from './execute.vscode';
import type { ExecuteCore, ExecuteShared } from './execute.vscode';
import { startMcpServer } from './server';
import type { RunningMcpServer } from './server';
import { SERVER_INSTRUCTIONS } from './prompts';
import { registerCatalogTools } from './tools';
import type { McpCatalogEnv } from './tools';

const run = promisify(execFile);

/** The id of the provider in `contributes.mcpServerDefinitionProviders`. */
const PROVIDER_ID = 'aantje.mcp';
/** The name of the server in Claude Code's configuration. */
const SERVER_NAME = 'aantje';
const BRIDGE_FILE = 'aantje-mcp-bridge.js';
/** The Claude Code extension, which brings its own CLI. */
const CLAUDE_CODE_EXTENSION = 'anthropic.claude-code';
/** Set once the hint that offers the server to Claude Code was shown, or the server was added. */
const HINT_SHOWN = 'aantje.mcp.claudeCodeHintShown';
const ADD = 'Add to Claude Code';
/** How long the question to Claude Code's CLI whether it has the server may take. */
const CLI_TIMEOUT_MS = 15_000;
/** How long the server of another window file may take to answer before its file is kept as a slow window's. */
const LEFTOVER_PROBE_MS = 3000;

/** What the server reads of aantje: the profiles of the store, the explorer's readers, and data access. */
export interface McpCore extends ExecuteCore {
  readonly store: { list(): readonly ConnectionProfile[]; get(id: string): ConnectionProfile | undefined };
  readonly catalogTree: ExecuteCore['catalogTree'];
  /** Data access that never asks for a sign-in: a tool call must not open a dialog. */
  readonly quietAccess: DataAccessFactory;
  readonly iceberg: {
    readonly targets: Pick<IcebergTargetStore, 'list'>;
    readonly copies: Pick<IcebergCopies, 'list'>;
    readonly statuses: Pick<IcebergStatuses, 'checkOne'>;
  };
}

export interface McpShared extends ExecuteShared {
  readonly logger: Logger;
  readonly register: Register;
  readonly parser: SqlParser & SqlTokenizer;
  readonly secrets: Pick<SecretRegistry, 'redact'>;
  /** The view of aantje: the hint for Claude Code waits until the user sees it. */
  readonly view: ShownView;
}

const enabled = (): boolean => vscode.workspace.getConfiguration('aantje').get<boolean>('mcp.enabled', true);

/** The Claude Code CLI: the one the Claude Code extension brings, else `claude` on the path. */
function claudeCli(): string {
  const extension = vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION);
  const bundled = extension
    ? join(
        extension.extensionPath,
        'resources',
        'native-binary',
        process.platform === 'win32' ? 'claude.exe' : 'claude',
      )
    : undefined;
  return bundled && existsSync(bundled) ? bundled : 'claude';
}

/** Copies the bridge to its version-independent place, when it is missing or differs. */
async function placeBridge(source: string, target: string): Promise<void> {
  const [from, to] = await Promise.all([readFile(source), readFile(target).catch(() => undefined)]);
  if (to?.equals(from)) return;
  await copyFile(source, target);
}

/** What the catalog tools read: the reader of a connected connection and the snapshot that the explorer shows. */
function catalogEnv(core: McpCore, { logger, parser, secrets }: McpShared): McpCatalogEnv {
  const { catalogTree: tree } = core;
  return {
    profiles: () => core.store.list(),
    catalog: (id) => {
      const reader = tree.reader(id);
      const state = tree.state(id);
      const snapshot = shownSnapshot(state);
      return reader && snapshot !== undefined
        ? { reader, snapshot, newest: state.snapshot === 'latest' }
        : undefined;
    },
    parser,
    dataAccess: (profile) => core.quietAccess(profile, undefined),
    iceberg: {
      targets: () => core.iceberg.targets.list(),
      records: (connectionId) => core.iceberg.copies.list(connectionId),
      check: (connectionId, targetId) => core.iceberg.statuses.checkOne(connectionId, targetId),
      // The question of the sync is the one of aantje's Iceberg commands, which own the flow.
      requestSync: async (request) =>
        vscode.commands.executeCommand<RequestedSync | undefined>(REQUEST_SYNC, request),
    },
    redact: (text) => secrets.redact(text),
    log: logger,
  };
}

/**
 * Removes the window files that no running window owns: a hard stop of the editor (a container that is rebuilt, a
 * killed extension host) leaves its file behind, and a bridge must not take it for a window.
 */
async function removeLeftovers(windows: string, own: string, logger: Logger): Promise<void> {
  try {
    const files = await leftoverWindowFiles(windows, own, processAlive, LEFTOVER_PROBE_MS);
    await Promise.all(files.map((file) => removeWindowEntry(file)));
    if (files.length > 0) {
      logger.info(`MCP: removed ${files.length} window file(s) of windows that no longer run.`);
    }
  } catch (error) {
    logger.warn(`MCP: the window files of other windows could not be checked: ${messageOf(error)}`);
  }
}

export function registerMcpServer(
  context: vscode.ExtensionContext,
  core: McpCore,
  shared: McpShared,
): vscode.Disposable[] {
  const { logger, register, view } = shared;
  const execute = createExecuteTools(core, shared);
  const catalog = { ...catalogEnv(core, shared), execute: execute.env };
  const folder = join(context.globalStorageUri.fsPath, 'mcp');
  const bridge = join(folder, BRIDGE_FILE);
  const declared = (context.extension.packageJSON as { version?: unknown }).version;
  const version = typeof declared === 'string' ? declared : '0.0.0';
  const changed = new vscode.EventEmitter<void>();
  let running: RunningMcpServer | undefined;
  let windowFile: string | undefined;
  let queue: Promise<void> = Promise.resolve();

  const folders = (): string[] => (vscode.workspace.workspaceFolders ?? []).map(({ uri }) => uri.fsPath);

  async function writeEntry(): Promise<void> {
    if (!running) return;
    windowFile = await writeWindowEntry(join(folder, WINDOWS_FOLDER), {
      pid: process.pid,
      url: running.url,
      token: running.token,
      folders: folders(),
    });
  }

  async function start(): Promise<void> {
    if (running || !enabled()) return;
    running = await startMcpServer({
      name: 'aantje',
      version,
      instructions: SERVER_INSTRUCTIONS,
      log: logger,
      register: (server) => registerCatalogTools(server, catalog),
    });
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await placeBridge(context.asAbsolutePath(join('dist', 'mcp-bridge.js')), bridge);
    await writeEntry();
    logger.info(`MCP: the server of aantje listens on ${running.url}.`);
    void removeLeftovers(join(folder, WINDOWS_FOLDER), windowFile ?? '', logger);
    changed.fire();
  }

  async function stop(): Promise<void> {
    const server = running;
    running = undefined;
    if (windowFile) await removeWindowEntry(windowFile);
    windowFile = undefined;
    if (server) {
      await server.close();
      await execute.closeSessions();
      logger.info('MCP: the server of aantje is stopped.');
      changed.fire();
    }
  }

  // Start, stop and rewrite one after another, so that a quick toggle of the setting cannot interleave them.
  const enqueue = (step: () => Promise<void>): void => {
    queue = queue
      .then(step)
      .catch((error: unknown) => logger.error('MCP: the server of aantje failed.', error));
  };
  enqueue(start);

  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () =>
      running
        ? [
            new vscode.McpHttpServerDefinition(
              'aantje',
              vscode.Uri.parse(running.url),
              { Authorization: `Bearer ${running.token}` },
              version,
            ),
          ]
        : [],
  };

  async function addToClaudeCode(): Promise<void> {
    await queue;
    if (!running) {
      void vscode.window.showWarningMessage(
        'The MCP server of aantje is switched off (aantje.mcp.enabled). Switch it on first.',
      );
      return;
    }
    const cli = claudeCli();
    // The bridge runs with the Node of the editor: Electron as Node on the desktop, Node itself in code-server.
    const entry = JSON.stringify({
      type: 'stdio',
      command: process.execPath,
      args: [bridge],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    try {
      await run(cli, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]).catch(() => undefined);
      await run(cli, ['mcp', 'add-json', '--scope', 'user', SERVER_NAME, entry]);
    } catch (error) {
      logger.error('MCP: adding the server to Claude Code failed.', error);
      void vscode.window.showErrorMessage(
        cli === 'claude'
          ? 'Claude Code was not found: install the Claude Code extension, or put `claude` on the path, then try again.'
          : 'Claude Code could not add the server of aantje. The output channel of aantje has the details.',
      );
      return;
    }
    logger.info(`MCP: added the server of aantje to Claude Code for this user (${cli}).`);
    await context.globalState.update(HINT_SHOWN, true);
    void vscode.window.showInformationMessage(
      'The MCP server of aantje is added to Claude Code for your user. Start a new Claude Code session to use it.',
    );
  }

  // Once: when Claude Code is installed and does not have the server yet, offer the command. Nothing is written
  // unless the user presses the button.
  async function offerToClaudeCode(): Promise<void> {
    await queue;
    if (
      !running ||
      context.globalState.get<boolean>(HINT_SHOWN) === true ||
      !vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION)
    ) {
      return;
    }
    await context.globalState.update(HINT_SHOWN, true);
    // Only a clear "not there" asks: a CLI that is missing or does not answer in time stays quiet.
    const missing = await run(claudeCli(), ['mcp', 'get', SERVER_NAME], { timeout: CLI_TIMEOUT_MS }).then(
      () => false,
      (error: { killed?: boolean; code?: unknown }) =>
        error.killed !== true && typeof error.code === 'number',
    );
    if (!missing) return;
    const answer = await vscode.window.showInformationMessage(
      'Claude Code can read the connected lakes of aantje through its MCP server: the objects, their statistics and the maintenance advice. Add the server to Claude Code for your user?',
      ADD,
    );
    if (answer === ADD) await addToClaudeCode();
  }

  return [
    whenShown(view, () => {
      offerToClaudeCode().catch((error: unknown) =>
        logger.error('MCP: offering the server to Claude Code failed.', error),
      );
    }),
    vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('aantje.mcp.enabled')) enqueue(enabled() ? start : stop);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => enqueue(writeEntry)),
    register('aantje.addMcpServerToClaudeCode', addToClaudeCode),
    changed,
    execute,
    { dispose: () => enqueue(stop) },
  ];
}
