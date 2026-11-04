import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { CatalogTree } from '../../src/tree/model';
import type { TreeNode } from '../../src/tree/refs';
import {
  copyDataFixture,
  dataMessages,
  gridTabs,
  observeWebviews,
  recordNotebooks,
  requireEngine,
  runOnCatalog,
  setSetting,
  useExtensionCache,
} from './data';
import type { DataFixture, WebviewRecord } from './data';
import { confirm, Desktop } from './desktop';
import { BIG_ORDERS_COLUMNS, ORDER_1, ORDER_3, ORDERS_GRID_COLUMNS } from './expectations';
import { activate, nodeAt, setConnections, tempDir, uniqueId, waitFor } from './support';

const NOT_TRUSTED = (name: string): string =>
  `You did not trust the connection "${name}", so its views are not resolved.`;
const QUESTION = (name: string): string =>
  `A view runs the SQL that is stored in the catalog of "${name}", with your rights on this machine: it can read files and use the network. aantje refuses a view that calls the maintenance functions of DuckLake when it shows the rows, resolves the columns or creates a notebook, but this is no sandbox, and a view that SQL of yours touches in the SQL editor is not checked. Resolve views only for catalogs that you trust.`;

describe('views, whose SQL DuckDB runs', function () {
  before(async function () {
    await requireEngine(this);
  });

  let tree: CatalogTree;
  let desktop: Desktop;
  let webviews: WebviewRecord[];
  let fixture: DataFixture;
  let name: string;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    webviews = observeWebviews();
    await useExtensionCache();
    fixture = await copyDataFixture('sqlite');
    ({ name } = fixture.profile);
    await setConnections([fixture.profile]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, name));
  });

  afterEach(() => {
    desktop.assertDone();
  });

  const view = (label = name): Promise<TreeNode> => nodeAt(tree, label, 'sales', 'Views', 'big_orders');
  const columns = (label = name): Promise<TreeNode> =>
    nodeAt(tree, label, 'sales', 'Views', 'big_orders', 'Columns');

  /** What the user sees below the Columns folder of the view after expanding it. */
  async function expand(label = name): Promise<string[]> {
    const children = await tree.children(await columns(label));
    return children.map(({ label: text, description }) => (description ? `${text} : ${description}` : text));
  }

  /**
   * Like `expand`, for the moment after the user trusted the connection: that reloads the tree, so the answer to the
   * question that was asked is empty, and the columns come with the next read. A reopen that a changed setting starts
   * on its own can still empty the tree for a moment; the path is there again when it has ended.
   */
  const resolve = (label = name): Promise<string[]> =>
    waitFor('the tree to read the view again', async () => {
      const lines = await expand(label).catch(() => []);
      return lines.length > 0 ? lines : undefined;
    });

  /** Clicking Refresh on the connection and waiting until it is open again, on a catalog read anew. */
  async function refresh(label = name): Promise<void> {
    const before = tree.reader(fixture.profile.id);
    await vscode.commands.executeCommand('aantje.refresh', await nodeAt(tree, label));
    await waitFor('the connection to be open again', () => {
      const reader = tree.reader(fixture.profile.id);
      return (
        tree.state(fixture.profile.id).status === 'connected' && reader !== undefined && reader !== before
      );
    });
  }

  it('shows only the Columns folder below a view, and its SQL in the tooltip, without asking anything', async () => {
    const node = await view();
    const children = await tree.children(node);

    assert.deepEqual(
      children.map(({ label, description, contextValue }) => ({ label, description, contextValue })),
      [{ label: 'Columns', description: undefined, contextValue: 'folder.viewColumns' }],
    );
    assert.ok(node.tooltip?.includes('SELECT * FROM sales.orders WHERE (amount > 1)'));
    assert.deepEqual(desktop.confirmations, []);
  });

  it('asks when the Columns folder of a view is expanded, and declining shows one message and starts no engine', async () => {
    // With this directory the engine would fail with another message, so the message below proves it never ran.
    const blocker = join(tempDir(), 'not-a-directory');
    writeFileSync(blocker, '');
    await setSetting('duckdb.extensionDirectory', blocker);
    desktop.answer(confirm(false));

    const node = await columns();
    const children = await tree.children(node);

    assert.deepEqual(
      children.map(({ label, contextValue }) => ({ label, contextValue })),
      [{ label: NOT_TRUSTED(name), contextValue: 'message' }],
    );
    assert.deepEqual(desktop.confirmations, [QUESTION(name)]);
    assert.deepEqual(desktop.confirmationActions, [['Trust and Resolve Views']]);
    assert.deepEqual(desktop.confirmationDetails, [
      `Catalog: ${fixture.profile.path}
You are asked again when the connection points to another place.`,
    ]);
    // The answer is kept until the next refresh: the tree does not ask again for the same node.
    assert.deepEqual(await tree.children(node), children);
    assert.equal(desktop.confirmations.length, 1);
    assert.deepEqual(desktop.errors, []);
  });

  it('asks again after a refresh, and the five columns of the view appear once the user accepts', async () => {
    desktop.answer(confirm(false), confirm(true));
    assert.deepEqual(await resolve(), [NOT_TRUSTED(name)]);

    await refresh();

    assert.deepEqual(await resolve(), BIG_ORDERS_COLUMNS);
    assert.deepEqual(desktop.confirmations, [QUESTION(name), QUESTION(name)]);
  });

  it('remembers the trust: a second expansion after a refresh does not ask again', async () => {
    desktop.answer(confirm(true));
    assert.deepEqual(await resolve(), BIG_ORDERS_COLUMNS);

    await refresh();

    assert.deepEqual(await resolve(), BIG_ORDERS_COLUMNS);
    assert.equal(desktop.confirmations.length, 1);
  });

  it('asks again after "Revoke Trust in Views"', async () => {
    desktop.answer(confirm(true), confirm(true));
    await resolve();
    // Still trusted after a refresh: so the revoke below is what makes it ask again.
    await refresh();
    assert.deepEqual(await resolve(), BIG_ORDERS_COLUMNS);
    assert.equal(desktop.confirmations.length, 1);

    await vscode.commands.executeCommand('aantje.revokeViewTrust');
    await refresh();

    assert.deepEqual(desktop.infos, ['aantje asks again before it resolves the views of a connection.']);
    assert.deepEqual(await resolve(), BIG_ORDERS_COLUMNS);
    assert.equal(desktop.confirmations.length, 2);
  });

  it('asks again when the connection points to another catalog, but not when it is only renamed', async () => {
    desktop.answer(confirm(true), confirm(true));
    await resolve();

    await setConnections([{ ...fixture.profile, name: 'Renamed lake' }]);
    await refresh('Renamed lake');
    assert.deepEqual(await resolve('Renamed lake'), BIG_ORDERS_COLUMNS);
    assert.equal(desktop.confirmations.length, 1, 'a new name is still the same catalog');

    const other = await copyDataFixture('sqlite');
    await setConnections([{ ...other.profile, id: fixture.profile.id, name: 'Renamed lake' }]);
    await refresh('Renamed lake');

    assert.deepEqual(await resolve('Renamed lake'), BIG_ORDERS_COLUMNS);
    assert.deepEqual(desktop.confirmations, [QUESTION(name), QUESTION('Renamed lake')]);
  });

  it('resolves the expanded Columns folder by itself when the user trusts the connection through "Select Top 1000 Rows"', async () => {
    desktop.answer(confirm(false), confirm(true));
    assert.deepEqual(await resolve(), [NOT_TRUSTED(name)]);

    await vscode.commands.executeCommand('aantje.previewTable', await view());

    // The tree reloads on its own: no Refresh is needed to replace the refusal by the columns.
    assert.deepEqual(await resolve(), BIG_ORDERS_COLUMNS);
    assert.equal(desktop.confirmations.length, 2);
  });

  it('resolves the Columns folder of the connection whose views the user trusted, and does not touch the other connection', async () => {
    const second = await copyDataFixture('sqlite');
    const other = { ...second.profile, id: uniqueId('other-lake'), name: 'Other lake' };
    await setConnections([fixture.profile, other]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, other.name));
    const untouched = tree.reader(fixture.profile.id);
    assert.ok(untouched, 'the first connection is open');
    desktop.answer(confirm(false), confirm(true));
    assert.deepEqual(await resolve(other.name), [NOT_TRUSTED(other.name)]);

    await vscode.commands.executeCommand('aantje.previewTable', await view(other.name));

    assert.deepEqual(await resolve(other.name), BIG_ORDERS_COLUMNS);
    assert.deepEqual(desktop.confirmations, [QUESTION(other.name), QUESTION(other.name)]);
    assert.equal(
      tree.reader(fixture.profile.id),
      untouched,
      'the catalog of the other connection was not read again',
    );
    assert.equal(tree.state(fixture.profile.id).status, 'connected');
  });

  it('asks before "Select Top 1000 Rows" reads a view, and shows the rows of the view after the user accepts', async () => {
    desktop.answer(confirm(false), confirm(true));

    await vscode.commands.executeCommand('aantje.previewTable', await view());
    // Declining is the user's choice: the command says so as information, not as an error.
    assert.deepEqual(desktop.infos, [NOT_TRUSTED(name)]);
    assert.deepEqual(desktop.errors, []);
    assert.deepEqual(gridTabs(), []);
    assert.deepEqual(desktop.progress, [], 'nothing was read');

    await vscode.commands.executeCommand('aantje.previewTable', await view());
    const [grid] = webviews;
    assert.ok(grid);
    await waitFor('the rows of the view', () => dataMessages(grid).length === 1);

    assert.deepEqual(gridTabs(), [`sales.big_orders (top 1000) · ${name} @13`]);
    const { elapsedMs: _, ...data } = (dataMessages(grid)[0] as { data: { elapsedMs: number } }).data;
    assert.deepEqual(data, {
      table: { schema: 'sales', table: 'big_orders' },
      columns: ORDERS_GRID_COLUMNS,
      rows: [ORDER_1, ORDER_3],
      limit: 1000,
      truncated: false,
    });
    // The trust given by Select Top 1000 Rows is the trust of the connection.
    assert.deepEqual(await resolve(), BIG_ORDERS_COLUMNS);
    assert.equal(desktop.confirmations.length, 2);
  });

  it('creates the notebook of a view that only reads, after the same check as the preview', async () => {
    const notebooks = recordNotebooks();
    desktop.answer(confirm(true));

    await vscode.commands.executeCommand('aantje.createNotebook', await view());

    assert.deepEqual(desktop.errors, []);
    assert.equal(notebooks.length, 1);
    assert.ok(notebooks[0]?.some((cell) => cell.includes('"sales"."big_orders"')));
  });

  it('refuses to create the notebook of a view that calls a maintenance function of DuckLake, so the kernel of the user never runs it', async () => {
    const notebooks = recordNotebooks();
    await runOnCatalog(
      fixture,
      "UPDATE meta.ducklake_view SET sql = 'SELECT * FROM ducklake_cleanup_old_files(''lake'', cleanup_all => true)' WHERE view_name = 'big_orders'",
    );
    desktop.answer(confirm(true));

    await vscode.commands.executeCommand('aantje.createNotebook', await view());

    assert.equal(desktop.errors.length, 1);
    assert.match(
      desktop.errors[0] ?? '',
      /^The view "sales\.big_orders" is not run: its SQL calls "ducklake_cleanup_old_files"/,
    );
    assert.deepEqual(notebooks, []);
  });

  it('refuses to create the notebook of a table whose name a view shares in another case', async () => {
    const notebooks = recordNotebooks();
    await runOnCatalog(
      fixture,
      "UPDATE meta.ducklake_view SET view_name = 'ORDERS' WHERE view_name = 'big_orders'",
    );
    const orders = await nodeAt(tree, name, 'sales', 'Tables', 'orders');

    await vscode.commands.executeCommand('aantje.createNotebook', orders);

    assert.equal(desktop.errors.length, 1);
    assert.match(desktop.errors[0] ?? '', /^"sales\.orders" is not read: the lake has 2 relations/);
    assert.deepEqual(notebooks, []);
  });
});
