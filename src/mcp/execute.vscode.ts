// The VS Code side of the MCP tools that run a statement: their read-only sessions, which close when the explorer
// disconnects the connection; the trust in views; the performance tips; the settings; open_sql.
import * as vscode from 'vscode';
import type { ConnectionProfile } from '../connections/profile';
import { maxRowsOf, timeoutMsOf, wholeNumberOf } from '../data/settings';
import type { SqlTokenizer } from '../dependencies/parser';
import { messageOf } from '../errors';
import type { Logger } from '../log';
import { openSqlSession } from '../sql/session';
import { performanceTips } from '../tips/connection';
import type { TipsEnv } from '../tips/connection';
import type { CatalogTree } from '../tree/model';
import type { ExecuteToolsEnv } from './execute-tools';
import { McpSessions } from './sessions';

/** The largest `aantje.mcp.maxRows`; keep in step with its maximum in package.json. */
const MAX_SAMPLE_ROWS = 1000;

export interface ExecuteCore extends TipsEnv {
  readonly catalogTree: Pick<CatalogTree, 'reader' | 'state' | 'onDidChange'>;
  readonly trust: { isTrusted(profile: ConnectionProfile): boolean };
  /** aantje's question whether to trust the views of a connection; throws on a decline. */
  readonly confirmViewsOf: (profile: ConnectionProfile) => Promise<void>;
}

export interface ExecuteShared {
  readonly logger: Logger;
  readonly parser: SqlTokenizer;
  readonly dataActions: { openSql(connectionId: string, text: string): Promise<void> };
}

const setting = (name: string): unknown => vscode.workspace.getConfiguration('aantje').get<unknown>(name);

export interface ExecuteTools {
  readonly env: ExecuteToolsEnv;
  /** Closes the sessions, as when the server stops. */
  closeSessions(): Promise<void>;
  /** Stops following the explorer at once; the sessions close after the calls that use them. */
  dispose(): void;
}

export function createExecuteTools(
  core: ExecuteCore,
  { logger, parser, dataActions }: ExecuteShared,
): ExecuteTools {
  const sessions = new McpSessions({
    open: async (profile, signal) =>
      openSqlSession({ access: await core.quietAccess(profile, undefined), mode: 'read-only', signal }),
    onError: (_, error) => logger.warn(`MCP: closing a session failed: ${messageOf(error)}`),
  });
  // A session keeps the lake open; it goes with the explorer's connection, so that a writable SQL editor can take the
  // lock of a DuckDB file after the editor disconnected the explorer.
  const listener = core.catalogTree.onDidChange(() => {
    for (const id of sessions.connections()) {
      if (core.catalogTree.state(id).status !== 'connected') void sessions.close(id);
    }
  });
  return {
    env: {
      sessions,
      tokenizer: parser,
      trust: {
        trusted: (profile) => core.trust.isTrusted(profile),
        confirm: (profile) => core.confirmViewsOf(profile),
      },
      tips: performanceTips(core, logger),
      timeoutMs: () => timeoutMsOf(setting('queryTimeoutSeconds')),
      resultRows: () => maxRowsOf(setting('sql.maxRows')),
      sampleRows: () => wholeNumberOf(setting('mcp.maxRows'), { min: 0, max: MAX_SAMPLE_ROWS, fallback: 0 }),
      openSql: (connectionId, text) => dataActions.openSql(connectionId, text),
    },
    closeSessions: () => sessions.dispose(),
    dispose() {
      listener.dispose();
      sessions.dispose().catch((error: unknown) => logger.error('MCP: closing the sessions failed.', error));
    },
  };
}
