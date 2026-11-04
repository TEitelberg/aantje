import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as vscode from 'vscode';
import type * as Duckdb from '@duckdb/node-api';
import type { FileProfile } from '../../src/connections/profile';
import { extension, onTeardown, onTeardownAsync, tempDir, uniqueId, waitFor } from './support';

/** The DuckDB extensions that the unit tests of the data engine cache; they are downloaded once, if at all. */
export function extensionCache(): string {
  return join(extension().extensionPath, 'test', '.cache', 'duckdb-extensions');
}

function loadDuckdb(): typeof Duckdb {
  // Resolved from the extension, like the extension itself does; the test bundle must not contain the native binding.
  return createRequire(join(extension().extensionPath, 'package.json'))('@duckdb/node-api') as typeof Duckdb;
}

let skipReason: Promise<string | undefined> | undefined;

/**
 * Why the tests that read table data cannot run (the DuckDB extensions are neither cached in
 * `test/.cache/duckdb-extensions` nor downloadable), or undefined. Computed once.
 */
export function engineSkipReason(): Promise<string | undefined> {
  skipReason ??= (async () => {
    try {
      const instance = await loadDuckdb().DuckDBInstance.create(':memory:', {
        extension_directory: extensionCache(),
      });
      const connection = await instance.connect();
      try {
        for (const name of ['ducklake', 'sqlite', 'httpfs']) {
          await connection.run(`INSTALL ${name}`);
          await connection.run(`LOAD ${name}`);
        }
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
      return undefined;
    } catch (error) {
      const reason = (error as Error).message.split('\n')[0];
      return `the DuckDB extensions ducklake, sqlite and httpfs are not in test/.cache/duckdb-extensions and cannot be downloaded (${reason})`;
    }
  })();
  return skipReason;
}

/**
 * A mocha hook for `before`: skips the suite, with the reason on the console, when the data engine cannot run.
 * A skipped suite is listed as pending by mocha, which does not print the reason itself.
 */
export function requireEngine(suite: Mocha.Context): Promise<void> {
  suite.timeout(120_000);
  return engineSkipReason().then((reason) => {
    if (reason) {
      console.warn(`SKIPPED ${suite.test?.parent?.title ?? 'a suite'}: ${reason}`);
      suite.skip();
    }
  });
}

export interface DataFixture {
  /** The connection as the setting `aantje.connections` holds it. */
  readonly profile: FileProfile & { readonly id: string };
  readonly directory: string;
}

/**
 * A private copy of a data fixture (`test/fixtures/data`: the DuckLake with its Parquet files). The data path
 * stored in the catalog is relative to the working directory of the reader, so the copy gets an absolute one;
 * `dataPath` overrides it, for example with an `s3://` location.
 */
export function copyDataFixture(
  kind: 'sqlite' | 'duckdb',
  dataPath?: (directory: string) => string,
): Promise<DataFixture> {
  return copyLake({ folder: 'data', catalog: 'data-catalog', label: 'Data lake' }, kind, dataPath);
}

/** A private copy of the history fixture (`test/fixtures/history`: 57 snapshots with Parquet files), like `copyDataFixture`. */
export function copyHistoryDataFixture(kind: 'sqlite' | 'duckdb'): Promise<DataFixture> {
  return copyLake({ folder: 'history', catalog: 'history', label: 'History lake' }, kind);
}

async function copyLake(
  { folder, catalog, label }: { folder: string; catalog: string; label: string },
  kind: 'sqlite' | 'duckdb',
  dataPath?: (directory: string) => string,
): Promise<DataFixture> {
  const source = join(extension().extensionPath, 'test', 'fixtures', folder);
  const directory = tempDir();
  const file = `${catalog}.${kind}`;
  cpSync(join(source, file), join(directory, file));
  cpSync(join(source, `${kind}-files`), join(directory, `${kind}-files`), { recursive: true });
  const location = dataPath?.(directory) ?? `${join(directory, `${kind}-files`).replaceAll('\\', '/')}/`;

  const instance = await loadDuckdb().DuckDBInstance.create(':memory:', {
    extension_directory: extensionCache(),
  });
  const connection = await instance.connect();
  try {
    if (kind === 'sqlite') {
      await connection.run('LOAD sqlite');
    }
    await connection.run(
      `ATTACH '${join(directory, file).replaceAll("'", "''")}' AS meta${kind === 'sqlite' ? ' (TYPE sqlite)' : ''}`,
    );
    await connection.run(
      `UPDATE meta.ducklake_metadata SET value = '${location.replaceAll("'", "''")}' WHERE key = 'data_path'`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  return {
    profile: { id: uniqueId(`data-${kind}`), name: `${label} (${kind})`, kind, path: join(directory, file) },
    directory,
  };
}

/** Runs statements on the SQLite catalog of a data fixture copy while no connection has it open, and returns the rows of the last one. */
export async function runOnCatalog(fixture: DataFixture, ...statements: string[]): Promise<unknown[][]> {
  const instance = await loadDuckdb().DuckDBInstance.create(':memory:', {
    extension_directory: extensionCache(),
  });
  const connection = await instance.connect();
  try {
    await connection.run('LOAD sqlite');
    await connection.run(`ATTACH '${fixture.profile.path.replaceAll("'", "''")}' AS meta (TYPE sqlite)`);
    let rows: unknown[][] = [];
    for (const statement of statements) {
      rows = (await connection.runAndReadAll(statement)).getRowsJson();
    }
    return rows;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** Writes a user setting of aantje (undefined removes it) and returns once the extension host knows it. It is removed again after the test. */
export async function setSetting(key: string, value: unknown): Promise<void> {
  const write = async (next: unknown): Promise<void> => {
    if (isDeepStrictEqual(vscode.workspace.getConfiguration('aantje').inspect(key)?.globalValue, next)) {
      return;
    }
    let listener: vscode.Disposable | undefined;
    const changed = new Promise<void>((resolve) => {
      listener = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`aantje.${key}`)) {
          resolve();
        }
      });
    });
    try {
      await vscode.workspace.getConfiguration('aantje').update(key, next, vscode.ConfigurationTarget.Global);
      await changed;
    } finally {
      listener?.dispose();
    }
  };
  await write(value);
  onTeardownAsync(() => write(undefined));
}

/** Lets the data engine find the cached DuckDB extensions, as a user without internet access would. */
export function useExtensionCache(): Promise<void> {
  return setSetting('duckdb.extensionDirectory', extensionCache());
}

export interface WebviewRecord {
  readonly viewType: string;
  readonly title: string;
  readonly panel: vscode.WebviewPanel;
  /** Everything the extension posted to the page, in order. */
  readonly messages: unknown[];
  /** The functions that the extension registered for what the page posts; a test calls them in place of the page. */
  readonly receivers: ((message: unknown) => unknown)[];
}

/**
 * Records the webview panels that the extension creates from now on, and what it posts to them (calls go
 * through, so the page really loads and answers). The panels are closed after the test.
 */
export function observeWebviews(): WebviewRecord[] {
  const records: WebviewRecord[] = [];
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = vscode.window.createWebviewPanel as (...args: unknown[]) => vscode.WebviewPanel;
  window.createWebviewPanel = (...args: unknown[]) => {
    const panel = original.apply(vscode.window, args);
    const record: WebviewRecord = {
      viewType: String(args[0]),
      title: String(args[1]),
      panel,
      messages: [],
      receivers: [],
    };
    const post = panel.webview.postMessage.bind(panel.webview);
    panel.webview.postMessage = (message: unknown) => {
      record.messages.push(message);
      return post(message);
    };
    const listen = panel.webview.onDidReceiveMessage.bind(panel.webview);
    // The event is an accessor of the webview, so a property of the instance takes its place.
    Object.defineProperty(panel.webview, 'onDidReceiveMessage', {
      configurable: true,
      value: (listener: (message: unknown) => unknown, ...rest: unknown[]) => {
        record.receivers.push(listener);
        return (listen as (...all: unknown[]) => vscode.Disposable)(listener, ...rest);
      },
    });
    records.push(record);
    return panel;
  };
  onTeardown(() => {
    window.createWebviewPanel = original;
  });
  onTeardownAsync(async () => {
    for (const { panel } of records) {
      panel.dispose();
    }
    await waitFor('the grid tabs to close', () => gridTabs().length === 0);
  });
  return records;
}

/** The labels of the open tabs that hold a grid, in the order of the tab groups. */
export function gridTabs(): string[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('aantje.grid'),
    )
    .map((tab) => tab.label);
}

/** The `data` messages among what the extension posted to a page. */
export function dataMessages(record: WebviewRecord): unknown[] {
  return record.messages.filter(
    (message) =>
      typeof message === 'object' && message !== null && 'type' in message && message.type === 'data',
  );
}

/** The notebooks that the extension creates from now on, as their cells; the Jupyter extension itself is not installed. */
export function recordNotebooks(): string[][] {
  const created: string[][] = [];
  const replace = (target: object, name: string, value: unknown): void => {
    const original: unknown = Reflect.get(target, name);
    assert.ok(Reflect.set(target, name, value), `${name} can be replaced`);
    onTeardown(() => {
      Reflect.set(target, name, original);
    });
  };
  const getExtension = vscode.extensions.getExtension.bind(vscode.extensions);
  replace(vscode.extensions, 'getExtension', (id: string) =>
    id === 'ms-toolsai.jupyter' ? ({ id } as vscode.Extension<unknown>) : getExtension(id),
  );
  replace(vscode.workspace, 'openNotebookDocument', (_type: string, data: vscode.NotebookData) => {
    created.push(data.cells.map((cell) => cell.value));
    return Promise.resolve({});
  });
  replace(vscode.window, 'showNotebookDocument', () => Promise.resolve({}));
  return created;
}
