import { randomBytes } from 'node:crypto';
import {
  MACHINE_SETTINGS,
  USER_SETTINGS,
  answerDialog,
  chooseFromContextMenu,
  collapseNode,
  contextMenuItems,
  dismissNotifications,
  expandNode,
  expect,
  hoverText,
  readTree,
  eventually,
  input,
  notificationButtons,
  notificationTexts,
  openView,
  openWorkbench,
  outline,
  pick,
  quickInput,
  readClipboard,
  runCommand,
  showOutputChannel,
  statusBarItem,
  treeRow,
  waitForNotification,
  writeClipboard,
} from '../lib/index.mjs';
import { allAantjeLogs, filesContaining, recordNotifications } from '../lib/postgres-secrets-support.mjs';
import { aantjeStatusText, titleAction } from '../lib/tree-features-helpers.mjs';
import {
  DATA,
  gridTab,
  installJupyter,
  gridTexts,
  installDataFixture,
  readGrid,
  runTool,
  s3Request,
  saveAs,
  s3FromEnvironment,
  webview,
} from '../lib/data-features-support.mjs';

export const title =
  'Data: Top 1000 rows in the grid, notebook, views, S3 credentials and data on a real S3 server';

const LAKE = 'Data lake';

// The title of a grid tab names the table, the limit, the connection and the snapshot: "sales.orders (top 1000) · Data lake @13".
const gridTitle = (table, snapshot, lake = LAKE) => `${table} (top 1000) · ${lake} @${snapshot}`;
const CSV = '/home/coder/project/sales.sortable.csv';
const CATALOG = `${DATA}/data-catalog.sqlite`;

// Needs an S3 server: test/e2e/run.ps1 starts it for a spec that reads E2E_S3_* (s3FromEnvironment) and hands over the data.
export default async function dataFeatures(t) {
  const { page, server } = t;
  const q = quickInput(page);
  const s3 = s3FromEnvironment();
  const seenNotifications = await recordNotifications(page);

  const openAantje = async () => {
    await openWorkbench(page, { url: t.url });
    await openView(page, 'aantje');
  };
  const connect = async (name) => {
    await expect(treeRow(page, name)).toBeVisible();
    await treeRow(page, name).click();
    await page.keyboard.press('ArrowRight');
    await expect(treeRow(page, name)).toHaveAttribute('aria-expanded', 'true');
  };
  // The tables and the views are in folders of their schema.
  const showTables = async () => {
    await expandNode(page, 'sales');
    await expandNode(page, 'Tables', { level: 3 });
  };
  const showViews = async () => {
    await expandNode(page, 'sales');
    await expandNode(page, 'Views', { level: 3 });
  };
  const previewOf = async (label) => {
    await chooseFromContextMenu(page, treeRow(page, label), 'Select Top 1000 Rows');
  };
  const machineSettings = async () => await server.readJson(MACHINE_SETTINGS);
  const setMachineSettings = async (values) =>
    server.writeFile(MACHINE_SETTINGS, JSON.stringify({ ...(await machineSettings()), ...values }));

  await t.step('prepare: data fixture, DuckDB extensions, the connection', async () => {
    await installDataFixture(server);
    // DuckDB downloads its extensions on first use (about 40 MB); the query timeout of 30 s must not depend on the
    // speed of the network of the test machine, so the harness downloads them once, to the same default directory.
    await runTool(server, ['prefetch'], { timeoutSeconds: 300 });
    await setMachineSettings({
      'aantje.connections': [{ id: 'data-lake', name: LAKE, kind: 'sqlite', path: CATALOG }],
    });
    await openAantje();
    await runCommand(page, 'View: Toggle Secondary Side Bar Visibility');
    await connect(LAKE);
    await showTables();
    await showViews();
    await expect
      .poll(() => outline(page))
      .toEqual([
        `${LAKE} : sqlite · DuckLake 1.1 · @13`,
        '  main',
        '  sales',
        '    Tables',
        '      orders',
        '    Views',
        '      big_orders',
        '    Macros',
        '  Snapshots',
      ]);
  });

  await t.step('Top 1000 rows of sales.orders: headers with types, NULL, JSON, status line', async () => {
    expect(await contextMenuItems(page, treeRow(page, 'orders'))).toEqual([
      'Copy Qualified Name',
      'Copy DDL',
      'New Query',
      'Script as',
      'Maintenance',
      'Time Travel',
      'Select Top 1000 Rows',
      'Create Notebook...',
      'Reports',
    ]);
    await previewOf('orders');
    await expect(gridTab(page)).toHaveCount(1);
    await expect(gridTab(page, gridTitle('sales.orders', 13))).toBeVisible();
    await expect(webview(page).locator('table')).toBeVisible({ timeout: 60_000 });
    const grid = await readGrid(page);
    expect(grid.headers).toEqual([
      { name: 'id', type: 'INTEGER', sort: '' },
      { name: 'customer', type: 'STRUCT("name" VARCHAR, "tags" VARCHAR[])', sort: '' },
      { name: 'attrs', type: 'MAP(VARCHAR, INTEGER)', sort: '' },
      { name: 'amount', type: 'DECIMAL(10,2)', sort: '' },
      { name: 'created', type: 'TIMESTAMP', sort: '' },
    ]);
    // Order 2 was deleted at snapshot 6: two rows. NULL cells are marked, nested values are JSON text.
    expect(grid.rows).toEqual([
      [
        { text: '1', isNull: false },
        { text: '{"name":"a","tags":["x"]}', isNull: false },
        { text: '[{"key":"k","value":1}]', isNull: false },
        { text: '1.50', isNull: false },
        { text: '2026-01-01 00:00:00', isNull: false },
      ],
      [
        { text: '3', isNull: false },
        { text: 'NULL', isNull: true },
        { text: 'NULL', isNull: true },
        { text: '3.00', isNull: false },
        { text: '2026-01-03 00:00:00', isNull: false },
      ],
    ]);
    expect(grid.numbers).toEqual(['1', '2']);
    expect(grid.status).toMatch(/^2 rows · \d+(\.\d)? (ms|s)$/);
    await t.shot('top-1000-orders');
  });

  await t.step('the pinned snapshot @5 shows the three rows from before the delete', async () => {
    await runCommand(page, 'aantje: Show Catalog at Snapshot...');
    await pick(page, '@5');
    await expect.poll(() => aantjeStatusText(page)).toBe(`${LAKE} · DuckLake 1.1 · @5 (pinned)`);
    await showTables();
    expect(await hoverText(page, treeRow(page, 'orders'))).toContain(
      'Rows in data files (inlined rows not included): 3',
    );
    await previewOf('orders');
    // A second tab: the snapshot belongs to the key of the panel and to the title.
    await expect(gridTab(page)).toHaveCount(2);
    await expect(gridTab(page, gridTitle('sales.orders', 5))).toBeVisible();
    await expect.poll(async () => (await readGrid(page)).rows.length).toBe(3);
    const grid = await readGrid(page);
    expect(grid.rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ['1', '{"name":"a","tags":["x"]}', '[{"key":"k","value":1}]', '1.50', '2026-01-01 00:00:00'],
      ['2', '{"name":"b","tags":[]}', '[]', '2.50', '2026-01-02 00:00:00'],
      ['3', 'NULL', 'NULL', '3.00', '2026-01-03 00:00:00'],
    ]);
    expect(grid.status).toMatch(/^3 rows · /);
    await t.shot('top-1000-orders-snapshot-5');

    // Back to the latest snapshot: the first panel is shown again, not a third one.
    await runCommand(page, 'aantje: Show Catalog at Snapshot...');
    await pick(page, 'Latest');
    await expect.poll(() => aantjeStatusText(page)).toBe(`${LAKE} · DuckLake 1.1 · latest (@13)`);
    await showTables();
    await previewOf('orders');
    await expect(gridTab(page)).toHaveCount(2);
    await expect.poll(async () => (await readGrid(page)).rows.length).toBe(2);
  });

  await t.step('sort, filter, copy on a table with numbers that sort differently as text', async () => {
    await runTool(server, [
      'ducklake',
      CATALOG,
      'CREATE TABLE lake.sales.sortable (n INTEGER, big BIGINT, price DECIMAL(10,2), flag BOOLEAN, label VARCHAR)',
      "INSERT INTO lake.sales.sortable VALUES (10, 9007199254740993, 9.99, true, 'item 10'), (9, 9007199254740992, 10.50, false, 'Item 9'), (2, NULL, NULL, NULL, NULL), (100, -5, 100.00, true, 'item 100')",
    ]);
    await titleAction(page, 'Refresh').click();
    await showTables();
    await expect(treeRow(page, 'sortable')).toBeVisible();
    await previewOf('sortable');
    await expect(gridTab(page)).toHaveCount(3);
    await expect.poll(async () => (await readGrid(page)).rows.length).toBe(4);
    const sorter = (name) =>
      webview(page)
        .locator('thead th')
        .filter({ has: page.locator(`.name:text-is("${name}")`) })
        .locator('button');
    const filter = (name) => webview(page).getByLabel(`Filter ${name}`);
    const column = async (index) => (await gridTexts(page)).map((row) => row[index]);
    const sortedBy = async (name) => (await readGrid(page)).headers.find((h) => h.sort !== '')?.name === name;

    // Numbers sort by value: as text 10 and 100 would come before 2 and 9.
    await sorter('n').click();
    await expect.poll(() => column(0)).toEqual(['2', '9', '10', '100']);
    expect(await sortedBy('n')).toBe(true);
    await t.shot('sorted-by-n-ascending');
    await sorter('n').click();
    await expect.poll(() => column(0)).toEqual(['100', '10', '9', '2']);
    await sorter('n').click();
    await expect.poll(() => column(0)).toEqual(['10', '9', '2', '100']);
    expect(await sortedBy('n')).toBe(false);

    // BIGINT beyond 2^53 and DECIMAL arrive as strings and are compared digit by digit; NULL is last in both directions.
    await sorter('big').click();
    await expect.poll(() => column(1)).toEqual(['-5', '9007199254740992', '9007199254740993', 'NULL']);
    await sorter('big').click();
    await expect.poll(() => column(1)).toEqual(['9007199254740993', '9007199254740992', '-5', 'NULL']);
    await sorter('price').click();
    await expect.poll(() => column(2)).toEqual(['9.99', '10.50', '100.00', 'NULL']);
    await sorter('flag').click();
    await expect.poll(() => column(3)).toEqual(['false', 'true', 'true', 'NULL']);
    // Text: case-insensitive, digits by value.
    await sorter('label').click();
    await expect.poll(() => column(4)).toEqual(['Item 9', 'item 10', 'item 100', 'NULL']);
    await sorter('label').click();
    await expect.poll(() => column(4)).toEqual(['item 100', 'item 10', 'Item 9', 'NULL']);
    await sorter('label').click();
    await expect.poll(() => column(4)).toEqual(['item 10', 'Item 9', 'NULL', 'item 100']);

    // Filter: case-insensitive substring of the shown text, NULL and !NULL, AND across columns.
    await filter('label').fill('ITEM 1');
    await expect.poll(() => column(4)).toEqual(['item 10', 'item 100']);
    expect((await readGrid(page)).status).toMatch(/^2 of 4 rows · /);
    await t.shot('filtered-by-label');
    await filter('n').fill('10');
    await expect.poll(() => column(0)).toEqual(['10', '100']);
    await filter('n').fill('');
    await filter('label').fill('');
    await filter('big').fill('NULL');
    await expect.poll(() => column(0)).toEqual(['2']);
    expect((await readGrid(page)).rows[0].map((cell) => cell.isNull)).toEqual([
      false,
      true,
      true,
      true,
      true,
    ]);
    await filter('big').fill('!NULL');
    await expect.poll(() => column(0)).toEqual(['10', '9', '100']);
    await filter('big').fill('');
    await filter('flag').fill('true');
    await expect.poll(() => column(0)).toEqual(['10', '100']);
    await filter('flag').fill('');
    await expect.poll(async () => (await readGrid(page)).rows.length).toBe(4);
    expect((await readGrid(page)).status).toMatch(/^4 rows · /);
    await t.shot('sortable');
  });

  await t.step('copy cell, row and all, and export CSV', async () => {
    const frame = webview(page);
    const cell = (row, column) => frame.locator(`tbody tr:nth-child(${row}) td:nth-child(${column + 2})`);
    const copied = async (action, expected) => {
      await writeClipboard(page, 'sentinel');
      await action();
      await expect.poll(() => readClipboard(page)).toBe(expected);
    };

    // The first row is (10, 9007199254740993, 9.99, true, 'item 10'); the third one is (2, NULL, ...).
    await cell(1, 4).click();
    await copied(() => page.keyboard.press('Control+c'), 'item 10');
    await expect(statusBarItem(page, 'Copied cell')).toBeVisible();
    await t.shot('copied-cell');
    await cell(3, 1).click();
    // A NULL cell copies nothing (the clipboard keeps its content) and says so in the status line.
    await writeClipboard(page, 'sentinel');
    await page.keyboard.press('Control+c');
    await expect(frame.locator('.status')).toHaveText('NULL: nothing copied');
    expect(await readClipboard(page)).toBe('sentinel');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowLeft');
    await copied(() => page.keyboard.press('Control+c'), '9');
    await cell(1, 2).click();
    await copied(() => frame.getByRole('button', { name: 'Copy cell', exact: true }).click(), '9.99');
    await copied(
      () => frame.getByRole('button', { name: 'Copy row', exact: true }).click(),
      '10\t9007199254740993\t9.99\ttrue\titem 10',
    );
    await cell(3, 0).click();
    await copied(() => frame.getByRole('button', { name: 'Copy row', exact: true }).click(), '2\t\t\t\t');
    await copied(
      () => frame.getByRole('button', { name: 'Copy all', exact: true }).click(),
      'n\tbig\tprice\tflag\tlabel\n10\t9007199254740993\t9.99\ttrue\titem 10\n9\t9007199254740992\t10.50\tfalse\tItem 9\n2\t\t\t\t\n100\t-5\t100.00\ttrue\titem 100',
    );
    // "All" means the rows that are shown: sorted and filtered.
    await frame
      .locator('thead th')
      .filter({ has: page.locator('.name:text-is("n")') })
      .locator('button')
      .click();
    await frame.getByLabel('Filter label').fill('item');
    await expect.poll(() => gridTexts(page).then((rows) => rows.length)).toBe(3);
    await copied(
      () => frame.getByRole('button', { name: 'Copy all', exact: true }).click(),
      'n\tbig\tprice\tflag\tlabel\n9\t9007199254740992\t10.50\tfalse\tItem 9\n10\t9007199254740993\t9.99\ttrue\titem 10\n100\t-5\t100.00\ttrue\titem 100',
    );

    await frame.getByRole('button', { name: 'Export CSV', exact: true }).click();
    // The save dialog of code-server is a prompt of the workbench: it suggests the folder of the project and the file name of the grid.
    await expect(q.input).toHaveValue('/home/coder/project/sales.sortable.csv');
    await t.shot('export-dialog');
    await page.keyboard.press('Enter');
    await waitForNotification(page, 'Saved /home/coder/project/sales.sortable.csv');
    // The file holds what is shown (sorted, filtered), CRLF between records, NULL would be an empty field.
    expect(await server.readFile(CSV)).toBe(
      [
        'n,big,price,flag,label',
        '9,9007199254740992,10.50,false,Item 9',
        '10,9007199254740993,9.99,true,item 10',
        '100,-5,100.00,true,item 100',
        '',
      ].join('\r\n'),
    );
  });

  await t.step('Create Notebook without the Jupyter extension: the error says what to install', async () => {
    await dismissNotifications(page);
    await showTables();
    await chooseFromContextMenu(page, treeRow(page, 'orders'), 'Create Notebook...');
    expect(await waitForNotification(page, /Jupyter/)).toBe(
      'Creating a notebook needs the Jupyter extension (ms-toolsai.jupyter). Install it and try again.',
    );
    await t.shot('notebook-without-jupyter');
  });

  await t.step('install the Jupyter extension and create the notebook', async () => {
    await installJupyter(server);
    await openAantje();
    await connect(LAKE);
    await showTables();
    await chooseFromContextMenu(page, treeRow(page, 'orders'), 'Create Notebook...');
    await expect(page.getByRole('tab', { name: /Untitled-1.ipynb/ })).toBeVisible();
    await expect(statusBarItem(page, 'Cell 1 of 8')).toBeVisible();
    await t.shot('notebook');
    // The cells of an untitled notebook cannot be read from the page: save it and read the file.
    await saveAs(page, '/home/coder/project/orders.ipynb');
    let notebook;
    await eventually(async () => {
      notebook = await server.readJson('/home/coder/project/orders.ipynb');
    });
    const cells = notebook.cells.map((cell) => ({
      kind: cell.cell_type,
      source: Array.isArray(cell.source) ? cell.source.join('') : cell.source,
    }));
    expect(cells.map((cell) => cell.kind)).toEqual([
      'markdown',
      'code',
      'code',
      'code',
      'code',
      'markdown',
      'code',
      'markdown',
    ]);
    const [title, pip, imports, configuration, connectCell, ask, query, next] = cells.map(
      (cell) => cell.source,
    );
    expect(title.split('\n')[0]).toBe('# `sales.orders`');
    expect(title).toContain('of the connection `Data lake` (SQLite catalog)');
    expect(title).toContain('**Snapshot:** follows the latest snapshot');
    expect(title).toContain('this notebook stores no password');
    expect(pip).toBe('%pip install "duckdb>=2.0.0" pandas');
    expect(imports).toMatch(
      /^import atexit\nimport getpass\nimport os\nimport shutil\nimport tempfile\n\nimport duckdb\n/,
    );
    expect(configuration).toContain("CATALOG_PATH = '/home/coder/project/data/data-catalog.sqlite'");
    expect(configuration).toContain('SNAPSHOT = None');
    expect(connectCell).toContain("'ATTACH ' + lit('ducklake:sqlite:' + CATALOG_PATH) + ' AS lake ('");
    expect(connectCell).toContain("options = ['READ_ONLY']");
    expect(connectCell).toContain("con.execute('USE lake')");
    expect(ask).toMatch(/^## Ask your question\n/);
    expect(query).toBe(`QUERY = '''SELECT * FROM lake."sales"."orders" LIMIT 1000'''\ncon.sql(QUERY).df()`);
    expect(next).toMatch(/^## Next steps\n/);

    // A tree that pins a snapshot makes a notebook that is pinned to it.
    await runCommand(page, 'aantje: Show Catalog at Snapshot...');
    await pick(page, '@5');
    await expect.poll(() => aantjeStatusText(page)).toBe(`${LAKE} · DuckLake 1.1 · @5 (pinned)`);
    await showTables();
    await chooseFromContextMenu(page, treeRow(page, 'orders'), 'Create Notebook...');
    await expect(page.getByRole('tab', { name: /Untitled-1\.ipynb/ })).toBeVisible();
    await saveAs(page, '/home/coder/project/orders-5.ipynb');
    let pinned;
    await eventually(async () => {
      pinned = await server.readJson('/home/coder/project/orders-5.ipynb');
    });
    const pinnedCells = pinned.cells.map((cell) => [cell.source].flat().join(''));
    expect(pinnedCells[0]).toContain('**Snapshot:** pinned to snapshot 5.');
    expect(pinnedCells[3]).toContain('SNAPSHOT = 5\n');
    await runCommand(page, 'aantje: Show Catalog at Snapshot...');
    await pick(page, 'Latest');
    await expect.poll(() => aantjeStatusText(page)).toBe(`${LAKE} · DuckLake 1.1 · latest (@15)`);
  });

  const TRUST_MESSAGE = `A view runs the SQL that is stored in the catalog of "${LAKE}", with your rights on this machine: it can read files and use the network. aantje refuses a view that calls the maintenance functions of DuckLake when it shows the rows, resolves the columns or creates a notebook, but this is no sandbox, and a view that SQL of yours touches in the SQL editor is not checked. Resolve views only for catalogs that you trust.`;
  const reopenTree = async () => {
    await openAantje();
    // The workbench restores the editors of the last session; a notebook has a web view of its own.
    await runCommand(page, 'View: Close All Editors');
    await connect(LAKE);
    await showTables();
    await showViews();
  };

  // The columns of a view are the folder Columns of the view (level 5), the only child of a view.
  const viewColumns = () => treeRow(page, 'Columns', { level: 5 });
  const VIEW_COLUMNS = [
    '          id : INTEGER NOT NULL',
    '          customer : STRUCT("name" VARCHAR, "tags" VARCHAR[])',
    '          attrs : MAP(VARCHAR, INTEGER)',
    '          amount : DECIMAL(10,2)',
    '          created : TIMESTAMP',
  ];
  const DECLINED = `          You did not trust the connection "${LAKE}", so its views are not resolved.`;
  // The tree with the view big_orders and its folder Columns expanded; `columns` are the rows below that folder.
  const lakeTree = (...columns) => [
    `${LAKE} : sqlite · DuckLake 1.1 · @15`,
    '  main',
    '  sales',
    '    Tables',
    '      orders',
    '      sortable',
    '    Views',
    '      big_orders',
    '        Columns',
    ...columns,
    '    Macros',
    '  Snapshots',
  ];

  await t.step(
    'views: expanding the view asks nothing, expanding its Columns folder asks once; declining leaves one message',
    async () => {
      await reopenTree();
      await expandNode(page, 'big_orders');
      await expect(page.locator('.monaco-dialog-box'), 'the view itself needs no confirmation').toHaveCount(
        0,
      );
      await expect(viewColumns()).toBeVisible();
      expect(
        (await readTree(page)).filter((row) => row.level === 5).map((row) => row.label),
        'a view has only the folder Columns',
      ).toEqual(['Columns']);
      await viewColumns().locator('.label-name').click();
      await answerDialog(page, 'Cancel', { message: TRUST_MESSAGE });
      await expect.poll(() => outline(page)).toEqual(lakeTree(DECLINED));
      await t.shot('view-declined');
    },
  );

  await t.step('views: refresh asks again; trusting shows the five columns with types', async () => {
    await titleAction(page, 'Refresh').click();
    await expect(viewColumns()).toBeVisible();
    // The folder is still expanded, so the refresh reads it again and the question comes again.
    await answerDialog(page, 'Trust and Resolve Views', { message: TRUST_MESSAGE });
    await expect.poll(() => outline(page)).toEqual(lakeTree(...VIEW_COLUMNS));
    await t.shot('view-columns');
  });

  await t.step('views: the trust survives a restart of code-server (global state)', async () => {
    await server.restart();
    await reopenTree();
    await expandNode(page, 'big_orders');
    await expandNode(page, 'Columns', { level: 5 });
    await expect.poll(() => outline(page)).toEqual(lakeTree(...VIEW_COLUMNS));
    await expect(page.locator('.monaco-dialog-box')).toHaveCount(0);
    await t.shot('view-columns-after-restart');
  });

  await t.step(
    'views: Revoke Trust in Views makes it ask again; Top 1000 of the view works after trust',
    async () => {
      await dismissNotifications(page);
      await runCommand(page, 'aantje: Revoke Trust in Views');
      await waitForNotification(page, 'aantje asks again before it resolves the views of a connection.');
      // The folder Columns is still expanded, so the refresh resolves it again and asks again.
      await titleAction(page, 'Refresh').click();
      await answerDialog(page, 'Cancel', { message: TRUST_MESSAGE });
      await expect.poll(() => outline(page)).toEqual(lakeTree(DECLINED));
      // Top 1000 on a view asks as well; declining reads nothing.
      await chooseFromContextMenu(page, treeRow(page, 'big_orders'), 'Select Top 1000 Rows');
      await answerDialog(page, 'Cancel', { message: TRUST_MESSAGE });
      // The user chose: no error message, and the grid stays away.
      await expect.poll(() => notificationTexts(page)).toEqual([]);
      await expect(gridTab(page).filter({ hasText: 'big_orders' })).toHaveCount(0);
      await t.shot('view-preview-declined');

      await chooseFromContextMenu(page, treeRow(page, 'big_orders'), 'Select Top 1000 Rows');
      await answerDialog(page, 'Trust and Resolve Views', { message: TRUST_MESSAGE });
      await expect(gridTab(page, gridTitle('sales.big_orders', 15))).toBeVisible();
      // Trusting through the grid refreshes the connection, so the folder Columns shows the columns without a Refresh.
      await expect.poll(() => outline(page)).toEqual(lakeTree(...VIEW_COLUMNS));
      await expect(page.locator('.monaco-dialog-box')).toHaveCount(0);
      await expect.poll(async () => (await readGrid(page)).rows.length).toBe(2);
      const grid = await readGrid(page);
      expect(grid.headers.map((header) => `${header.name} ${header.type}`)).toEqual([
        'id INTEGER',
        'customer STRUCT("name" VARCHAR, "tags" VARCHAR[])',
        'attrs MAP(VARCHAR, INTEGER)',
        'amount DECIMAL(10,2)',
        'created TIMESTAMP',
      ]);
      // amount > 1 keeps the orders 1 and 3 (order 2 is deleted).
      expect(grid.rows.map((row) => `${row[0].text} ${row[3].text}`)).toEqual(['1 1.50', '3 3.00']);
      await t.shot('view-top-1000');
    },
  );

  // Throw-away values, like the ones of a real person; none of them may show up anywhere but in the secret storage.
  const random = (prefix) => `${prefix}${randomBytes(9).toString('hex')}`;
  const mine = { keyId: random('AKIAE2E'), secretKey: random('secret-e2e-') };
  const wrong = { keyId: random('AKIAWRONG'), secretKey: random('wrong-secret-') };
  const expectNoLeak = async (...values) => {
    const outputText = await (await showOutputChannel(page, 'aantje')).locator('.output-view').innerText();
    const settings = [USER_SETTINGS, MACHINE_SETTINGS];
    for (const value of values) {
      for (const file of settings) {
        expect(await server.readFile(file), `${file} must not hold a secret`).not.toContain(value);
      }
      expect(
        await filesContaining(server, value),
        'no file of the user data directory holds a secret',
      ).toEqual([]);
      expect(await allAantjeLogs(server), 'the log of aantje').not.toContain(value);
      expect(outputText, 'the aantje output channel').not.toContain(value);
      expect(seenNotifications.join('\n'), 'the notifications').not.toContain(value);
    }
  };
  const setCredentials = async ({ keyId, secretKey }) => {
    await runCommand(page, 'aantje: Set S3 Credentials...');
    await expect(q.title).toHaveText('Set S3 Credentials (1/2)');
    await expect(q.message).toContainText(
      'Access key id for the S3 storage that holds the data of the catalogs',
    );
    await expect(q.input).not.toHaveAttribute('type', 'password');
    await input(page, keyId, { title: 'Set S3 Credentials (1/2)' });
    await expect(q.title).toHaveText('Set S3 Credentials (2/2)');
    await expect(q.input).toHaveAttribute('type', 'password');
    await expect(q.message).toContainText(
      'Secret access key. It is kept in the secret storage, not in the settings.',
    );
    await q.input.fill(secretKey);
    await t.shot('secret-prompt-masked');
    await page.keyboard.press('Enter');
    await waitForNotification(page, 'The S3 credentials are stored in the secret storage.');
  };

  await t.step(
    'S3 credentials: a masked prompt, the secret storage, Clear; no secret in a file, log or message',
    async () => {
      await setCredentials(mine);
      await expectNoLeak(mine.keyId, mine.secretKey);
      await dismissNotifications(page);
      await runCommand(page, 'aantje: Clear S3 Credentials');
      await waitForNotification(
        page,
        'The stored S3 credentials were removed. Credentials from the environment, if any, still apply.',
      );
      await t.shot('credentials-cleared');
    },
  );

  const S3_LAKE = 'S3 lake';
  const BUCKET = 'e2e-lake';
  const S3_CATALOG = '/home/coder/project/s3/catalog.sqlite';
  const S3_HINT = 'the settings aantje.s3.* and the command "aantje: Set S3 Credentials..."';
  const S3_FORBIDDEN =
    /^Cannot read the data of "shop\.items": HTTP Error: HTTP GET error reading 's3:\/\/e2e-lake\/ducklake\/shop\/items\/ducklake-[0-9a-f-]+\.parquet' \(HTTP 403 Forbidden\)\./;
  const readItems = async () => {
    await chooseFromContextMenu(page, treeRow(page, 'items'), 'Select Top 1000 Rows');
  };

  await t.step(
    'S3: a bucket and a DuckLake whose Parquet files are in it; the connection and the settings',
    async () => {
      // The DuckLake is written the way a data engineer does it, with DuckDB and the S3 secret; aantje only reads it.
      expect((await s3Request(server, s3, 'PUT', `/${BUCKET}`)).status).toBe(200);
      await server.exec('mkdir -p /home/coder/project/s3');
      await runTool(server, ['s3-lake'], {
        timeoutSeconds: 180,
        env: {
          TOOL_S3_ENDPOINT: `${s3.host}:${s3.port}`,
          TOOL_S3_REGION: 'us-east-1',
          TOOL_S3_KEY_ID: s3.keyId,
          TOOL_S3_SECRET: s3.secretKey,
          TOOL_S3_BUCKET: BUCKET,
          TOOL_CATALOG: S3_CATALOG,
        },
      });
      const listing = await s3Request(server, s3, 'GET', `/${BUCKET}?list-type=2&prefix=ducklake/`);
      expect(listing.status).toBe(200);
      // The Parquet file of the table is in the bucket, not on the disk of the code-server container.
      expect(listing.body).toMatch(/<Key>ducklake\/shop\/items\/ducklake-[0-9a-f-]+\.parquet<\/Key>/);

      await dismissNotifications(page);
      await setMachineSettings({
        'aantje.connections': [
          { id: 'data-lake', name: LAKE, kind: 'sqlite', path: CATALOG },
          { id: 's3-lake', name: S3_LAKE, kind: 'sqlite', path: S3_CATALOG },
        ],
        'aantje.s3.endpoint': s3.endpoint,
        'aantje.s3.region': 'us-east-1',
        'aantje.s3.urlStyle': 'path',
      });
      await reopenTree();
      await collapseNode(page, LAKE);
      await connect(S3_LAKE);
      await expandNode(page, 'shop');
      await expandNode(page, 'Tables', { level: 3 });
      expect(await hoverText(page, treeRow(page, 'items'))).toContain(
        'Rows in data files (inlined rows not included): 3',
      );
      await t.shot('s3-lake-tree');
    },
  );

  await t.step(
    'S3: without credentials the read fails with a text that names the settings and the command',
    async () => {
      await readItems();
      const message = await waitForNotification(page, /Cannot read the data of/);
      expect(message).toMatch(S3_FORBIDDEN);
      expect(message).toContain(S3_HINT);
      // A refused request (403) is something the health check can explain: the message has its button.
      expect(await notificationButtons(page, /Cannot read the data of/)).toEqual(['Check Table Health']);
      await t.shot('s3-no-credentials');
    },
  );

  await t.step(
    'S3: wrong credentials are refused; the message names the settings and the command, not the secret',
    async () => {
      await dismissNotifications(page);
      await setCredentials(wrong);
      await dismissNotifications(page);
      await readItems();
      const message = await waitForNotification(page, /Cannot read the data of/);
      expect(message).toMatch(S3_FORBIDDEN);
      expect(message).toContain(S3_HINT);
      expect(message).not.toContain(wrong.keyId);
      expect(message).not.toContain(wrong.secretKey);
      await t.shot('s3-wrong-credentials');
      await expectNoLeak(wrong.keyId, wrong.secretKey);
    },
  );

  await t.step(
    'S3: with the right credentials Top 1000 reads the Parquet file from the S3 server',
    async () => {
      await dismissNotifications(page);
      await setCredentials({ keyId: s3.keyId, secretKey: s3.secretKey });
      await dismissNotifications(page);
      await readItems();
      // The snapshot is the one the S3 lake has after its creation (schema, table, insert); any number proves the form.
      await expect(
        page.getByRole('tab', { name: new RegExp(`^shop\\.items \\(top 1000\\) · ${S3_LAKE} @\\d+$`) }),
      ).toBeVisible();
      await expect.poll(async () => (await readGrid(page)).rows.length).toBe(3);
      const grid = await readGrid(page);
      expect(grid.headers.map((header) => `${header.name} ${header.type}`)).toEqual([
        'id INTEGER',
        'label VARCHAR',
        'price DECIMAL(10,2)',
      ]);
      expect(grid.rows.map((row) => row.map((cell) => cell.text))).toEqual([
        ['1', 'apple', '0.50'],
        ['2', 'pear', '0.75'],
        ['3', 'NULL', '1.20'],
      ]);
      expect(grid.rows[2][1].isNull).toBe(true);
      expect(grid.status).toMatch(/^3 rows · /);
      await t.shot('s3-top-1000');
      await expectNoLeak(s3.keyId, s3.secretKey);
    },
  );

  await t.step('S3: Clear S3 Credentials takes the access away again', async () => {
    await dismissNotifications(page);
    await runCommand(page, 'aantje: Clear S3 Credentials');
    await waitForNotification(
      page,
      'The stored S3 credentials were removed. Credentials from the environment, if any, still apply.',
    );
    await dismissNotifications(page);
    await readItems();
    const message = await waitForNotification(page, /Cannot read the data of/);
    expect(message).toContain('(HTTP 403 Forbidden)');
    await t.shot('s3-cleared');
    await expectNoLeak(mine.keyId, mine.secretKey, wrong.keyId, wrong.secretKey, s3.keyId, s3.secretKey);
  });
}
