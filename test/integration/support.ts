import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as vscode from 'vscode';
import type { CatalogReader } from '../../src/catalog/model';
import type { ExtensionApi } from '../../src/extension';
import type { CatalogTree } from '../../src/tree/model';
import type { TreeNode } from '../../src/tree/refs';

const EXTENSION_ID = 'teitelberg.aantje';
const TIMEOUT_MS = 15_000;

export function extension(): vscode.Extension<ExtensionApi | undefined> {
  const found = vscode.extensions.getExtension<ExtensionApi | undefined>(EXTENSION_ID);
  if (!found) {
    throw new Error(`The extension ${EXTENSION_ID} is not loaded in the extension host.`);
  }
  return found;
}

/** Activates the extension (once; later calls return the same API). */
export async function activate(): Promise<ExtensionApi> {
  const api = await extension().activate();
  if (!api) {
    throw new Error(
      'The extension returned no API: it hands one out only when the extension host runs a test.',
    );
  }
  return api;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the probe returns something truthy: for conditions that become true on their own. */
export async function waitFor<T>(
  what: string,
  probe: () => T | PromiseLike<T>,
  timeoutMs = TIMEOUT_MS,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
    }
    await sleep(25);
  }
}

function withTimeout<T>(what: string, promise: Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// What a test changes in the shared host is undone after it: first the stubs, then the connections, and
// the temporary files last, because a catalog file cannot be removed while its reader is open.
const undo: (() => void)[] = [];
const undoAsync: (() => Promise<void>)[] = [];
const tempDirs: string[] = [];

/** Registers an action that runs after the current test, newest first. */
export function onTeardown(action: () => void): void {
  undo.push(action);
}

/** Like `onTeardown`, for an action that has to finish before the next test: it runs after the synchronous ones, newest first. */
export function onTeardownAsync(action: () => Promise<void>): void {
  undoAsync.push(action);
}

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aantje-vsc-data-'));
  tempDirs.push(dir);
  return dir;
}

/** A private copy of a checked-in catalog; DuckDB locks its file and a test must never change the original. */
export function copyFixture(name: 'ducklake.sqlite' | 'ducklake.duckdb' | 'history/history.sqlite'): string {
  const copy = join(tempDir(), basename(name));
  copyFileSync(join(extension().extensionPath, 'test', 'fixtures', name), copy);
  return copy;
}

/**
 * Asserts the shape of a destructive maintenance script: the only call that runs is the dry run of the procedure, and
 * the real call waits as a comment. Ages and notes follow the options of the lake; test/unit/maintenance.test.ts pins them.
 */
export function assertDryRunFirst(script: string, procedure: string): void {
  const lines = script.split('\n');
  const ofProcedure = (line: string) => line.startsWith(`CALL ${procedure}('lake'`);
  const active = lines.filter((line) => line.startsWith('CALL '));
  assert.ok(
    active.length === 1 && ofProcedure(active[0] ?? '') && active[0]?.includes('dry_run => true'),
    `${procedure}: the call that runs is its dry run (${active.join(' | ')})`,
  );
  const commented = lines.filter((line) => line.startsWith('-- CALL ')).map((line) => line.slice(3));
  assert.ok(
    commented.some((line) => ofProcedure(line) && !line.includes('dry_run')),
    `${procedure}: the real call is commented out (${commented.join(' | ')})`,
  );
}

/** A TCP port that nothing listens on: connecting to it is refused at once. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

let counter = 0;

/** Profile ids are unique per test, so the tree view never meets a node it showed (and expanded) in an earlier test. */
export function uniqueId(base: string): string {
  counter += 1;
  return `${base}-${counter}`;
}

export function connectionsSetting(): unknown {
  return vscode.workspace.getConfiguration('aantje').inspect('connections')?.globalValue;
}

/**
 * Writes the user setting `aantje.connections` (undefined removes it) and returns after the extension has
 * handled the change: the extension listens first, so when the listener of the test runs, it is done.
 */
export async function setConnections(value: unknown): Promise<void> {
  if (isDeepStrictEqual(connectionsSetting(), value)) {
    return;
  }
  let listener: vscode.Disposable | undefined;
  const handled = new Promise<void>((resolve) => {
    listener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('aantje.connections')) {
        resolve();
      }
    });
  });
  try {
    await vscode.workspace
      .getConfiguration('aantje')
      .update('connections', value, vscode.ConfigurationTarget.Global);
    await withTimeout('the extension to handle the change of aantje.connections', handled);
  } finally {
    listener?.dispose();
  }
}

/** Writes the user setting `aantje.queryTimeoutSeconds` (undefined removes it) and returns once the extension host knows it. */
export async function setQueryTimeout(seconds: number | undefined): Promise<void> {
  let listener: vscode.Disposable | undefined;
  const changed = new Promise<void>((resolve) => {
    listener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('aantje.queryTimeoutSeconds')) {
        resolve();
      }
    });
  });
  try {
    await vscode.workspace
      .getConfiguration('aantje')
      .update('queryTimeoutSeconds', seconds, vscode.ConfigurationTarget.Global);
    await withTimeout('the change of aantje.queryTimeoutSeconds', changed);
  } finally {
    listener?.dispose();
  }
}

/** The node at a path of labels from the connection down. Expands the nodes on the way, but not the one it returns. */
export async function nodeAt(tree: CatalogTree, ...path: string[]): Promise<TreeNode> {
  let nodes: readonly TreeNode[] = tree.roots();
  let found: TreeNode | undefined;
  for (const label of path) {
    if (found) {
      nodes = await tree.children(found);
    }
    found = nodes.find((node) => node.label === label);
    if (!found) {
      throw new Error(`No node "${label}" among ${nodes.map((node) => `"${node.label}"`).join(', ')}.`);
    }
  }
  if (!found) {
    throw new Error('A path of labels is required.');
  }
  return found;
}

/** The folders that tell more than the objects of the catalog: `outline` leaves them out (history.test.ts covers them). */
const EXTRA_FOLDERS = new Set(['statistics', 'history', 'partitioning', 'sortOrder', 'tags', 'snapshots']);

/**
 * Expands a node and everything below it: one line per node with its indentation, label and description. Only the
 * objects of the catalog, so the folders Statistics, History, Partitioning, Sort Order, Tags and Snapshots
 * are left out. The Columns folder of a view is not expanded: its columns come from DuckDB after a confirmation (see
 * data-views.test.ts).
 */
export async function outline(tree: CatalogTree, node: TreeNode, depth = 0): Promise<string[]> {
  const description = node.description === undefined ? '' : ` : ${node.description}`;
  const lines = [`${'  '.repeat(depth)}${node.label}${description}`];
  if (node.ref.kind === 'folder' && node.ref.folder === 'viewColumns') {
    return lines;
  }
  for (const child of await tree.children(node)) {
    if (child.ref.kind !== 'folder' || !EXTRA_FOLDERS.has(child.ref.folder)) {
      lines.push(...(await outline(tree, child, depth + 1)));
    }
  }
  return lines;
}

/**
 * Records the arguments of the calls that the tree receives from now on. That includes the calls of the real
 * tree view: VS Code asks the provider for the children of every node it expands, and for the parent of every
 * node it reveals (the extension itself reads the children when it searches, but never asks for a parent).
 */
export function observeTree(tree: CatalogTree, method: 'roots' | 'children' | 'parent'): unknown[][] {
  const calls: unknown[][] = [];
  const original = tree[method].bind(tree) as (...args: unknown[]) => unknown;
  Reflect.set(tree, method, (...args: unknown[]) => {
    calls.push(args);
    return original(...args);
  });
  onTeardown(() => {
    Reflect.deleteProperty(tree, method);
  });
  return calls;
}

type RevealOptions = Parameters<vscode.TreeView<TreeNode>['reveal']>[1];

/** Records the options of the `reveal` calls that the tree view receives from now on (calls go through). */
export function observeReveals(view: vscode.TreeView<TreeNode>): (RevealOptions | undefined)[] {
  const options: (RevealOptions | undefined)[] = [];
  const original = Reflect.get<vscode.TreeView<TreeNode>, 'reveal'>(view, 'reveal');
  Reflect.set(view, 'reveal', (node: TreeNode, revealOptions?: RevealOptions) => {
    options.push(revealOptions);
    return original.call(view, node, revealOptions);
  });
  onTeardown(() => {
    Reflect.set(view, 'reveal', original);
  });
  return options;
}

interface StatusBar {
  readonly item: vscode.StatusBarItem;
  readonly args: unknown[];
  visible: boolean;
}

const statusBarsOfExtension = new Map<string, StatusBar>();
const STATUS_ID = 'aantje.status';

/**
 * Records the status bar items that the extension creates (calls go through), so that tests can read what they
 * show. The extension creates them while it activates, so this has to run before that.
 */
export function observeStatusBar(): () => void {
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = vscode.window.createStatusBarItem as (...args: unknown[]) => vscode.StatusBarItem;
  window.createStatusBarItem = (...args: unknown[]) => {
    const item = original.apply(vscode.window, args);
    if (typeof args[0] === 'string' && args[0].startsWith('aantje.')) {
      const record: StatusBar = { item, args, visible: false };
      const show = item.show.bind(item);
      const hide = item.hide.bind(item);
      item.show = () => {
        record.visible = true;
        show();
      };
      item.hide = () => {
        record.visible = false;
        hide();
      };
      statusBarsOfExtension.set(args[0], record);
    }
    return item;
  };
  return () => {
    window.createStatusBarItem = original;
  };
}

/** What a status bar item of the extension shows right now: the one of the explorer, or the one of the SQL editor (`aantje.queryStatus`). */
export function statusBar(id = STATUS_ID): {
  visible: boolean;
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
} {
  const found = statusBarsOfExtension.get(id);
  if (!found) {
    throw new Error('The extension has not created its status bar item (yet).');
  }
  const { item, visible } = found;
  const { text, command } = item;
  const tooltip = typeof item.tooltip === 'object' ? item.tooltip.value : item.tooltip;
  return { visible, text, tooltip, command: typeof command === 'object' ? command.command : command };
}

/** How the extension created its status bar item: the arguments of `createStatusBarItem`, and the name it gave the item. */
export function statusBarSetup(): { args: unknown[]; name: string | undefined } {
  const found = statusBarsOfExtension.get(STATUS_ID);
  if (!found) {
    throw new Error('The extension has not created its status bar item (yet).');
  }
  return { args: found.args, name: found.item.name };
}

let treeViewOptions: vscode.TreeViewOptions<unknown> | undefined;

/** Records the options of the tree view that the extension creates. Like `observeStatusBar`, it has to run before activation. */
export function observeTreeView(): () => void {
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = vscode.window.createTreeView as (...args: unknown[]) => vscode.TreeView<unknown>;
  window.createTreeView = (...args: unknown[]) => {
    if (args[0] === 'aantje.catalogs') {
      treeViewOptions = args[1] as vscode.TreeViewOptions<unknown>;
    }
    return original.apply(vscode.window, args);
  };
  return () => {
    window.createTreeView = original;
  };
}

/** The options the extension gave its tree view. */
export function treeViewSetup(): vscode.TreeViewOptions<unknown> {
  if (!treeViewOptions) {
    throw new Error('The extension has not created its tree view (yet).');
  }
  return treeViewOptions;
}

/** The directory of the VS Code profile of this run (see .vscode-test.mjs). */
export function sandboxDir(): string {
  const dir = process.env.AANTJE_TEST_SANDBOX;
  if (!dir) {
    throw new Error('AANTJE_TEST_SANDBOX is not set: run the tests with "npm run test:integration".');
  }
  return dir;
}

/** The text of the "aantje" output channel. VS Code writes it to a log file of the extension host. */
export function readOutputChannel(): string {
  const find = (dir: string): string | undefined => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = find(path);
        if (found) return found;
      } else if (path.endsWith(join('teitelberg.aantje', 'aantje.log'))) {
        return path;
      }
    }
    return undefined;
  };
  const file = find(join(sandboxDir(), 'user-data', 'logs'));
  return file ? readFileSync(file, 'utf8').replaceAll('\r\n', '\n') : '';
}

/** Resolves once the reader refuses queries, i.e. after its `close()` ran. */
export async function waitUntilClosed(reader: CatalogReader): Promise<void> {
  await waitFor('the catalog reader to be closed', () =>
    reader.snapshots().then(
      () => false,
      () => true,
    ),
  );
}

/** Puts the shared host back to the state before the test: no stubs, no connections, no temporary files. */
export async function resetHost(): Promise<void> {
  while (undo.length > 0) {
    undo.pop()?.();
  }
  while (undoAsync.length > 0) {
    await undoAsync.pop()?.();
  }
  const api = extension().isActive ? extension().exports : undefined;
  const readers = api?.tree.roots().flatMap((root) => api.tree.reader(root.ref.connectionId) ?? []) ?? [];
  try {
    await setConnections(undefined);
    await Promise.all(readers.map(waitUntilClosed));
  } finally {
    for (const dir of tempDirs.splice(0)) {
      // A DuckDB file stays locked for a moment after its reader is closed; Windows reports that as EBUSY.
      rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
    }
  }
}
