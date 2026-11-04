import {
  FIXTURES,
  MACHINE_SETTINGS,
  activityBar,
  activityBarTab,
  answerDialog,
  around,
  chooseFromContextMenu,
  collapseNode,
  dismissNotifications,
  expandNode,
  expect,
  hoverText,
  input,
  openView,
  openWorkbench,
  outline,
  pick,
  quickInput,
  readClipboard,
  readTree,
  runCommand,
  setColorTheme,
  sidebar,
  treeRow,
  waitForNotification,
  writeClipboard,
} from '../lib/index.mjs';
import {
  aantjeStatus,
  aantjeStatusText,
  activePickLabel,
  activityIconContrast,
  iconColor,
  isGreen,
  allPickEntries,
  clickInlineAction,
  commitSchema,
  hoverWithShot,
  titleAction,
} from '../lib/tree-features-helpers.mjs';

export const title =
  'Tree features: tooltips, status bar, snapshots, search, copy, refresh, connection lifecycle, two connections, themes';

const LAKE = 'Fixture lake';
const FILE = `${FIXTURES}/ducklake.sqlite`;
const FILE_V1_0 = `${FIXTURES}/ducklake-1.0.sqlite`;
const MISSING = `${FIXTURES}/missing.sqlite`;

// The snapshots of the fixture, newest first (test/fixtures/README.md).
const SNAPSHOTS = ['@13', '@12', '@11', '@10', '@9', '@8', '@7', '@6', '@5', '@4', '@3', '@2', '@1', '@0'];

export default async function treeFeatures(t) {
  const { page } = t;
  const q = quickInput(page);
  const statusBar = () => aantjeStatusText(page);
  const connections = async () => (await t.server.readJson(MACHINE_SETTINGS))['aantje.connections'] ?? [];
  const waitForStatus = (text) => expect.poll(statusBar).toBe(text);
  // A connection that is expanded shows its schemas, then the folder Snapshots. No node shows a count.
  const atSchemas = (root, schemas = ['main', 'sales']) => [
    root,
    ...schemas.map((schema) => `  ${schema}`),
    '  Snapshots',
  ];
  const collapseAll = async () => {
    await titleAction(page, 'Collapse All').click();
    await expect.poll(async () => (await outline(page)).filter((line) => line.startsWith('  '))).toEqual([]);
  };
  const READ_ONLY = 'Open SQL editor sessions read-only?';
  const addSqliteConnection = async (name, path) => {
    await runCommand(page, 'aantje: Add Connection...');
    await pick(page, 'SQLite', { title: 'Add Connection: where is the DuckLake metadata stored?' });
    await input(page, name, { title: 'Add Connection (1/3)' });
    await input(page, path, { title: 'Add Connection (2/3)' });
    await pick(page, 'No', { title: `Add Connection (3/3): ${READ_ONLY}` });
  };

  await t.step('a disconnected connection: status bar, tooltip, inline Connect, then connected', async () => {
    const settings = await t.server.readJson(MACHINE_SETTINGS);
    await t.server.writeFile(
      MACHINE_SETTINGS,
      JSON.stringify({
        ...settings,
        'aantje.connections': [{ id: 'fixture-lake', name: LAKE, kind: 'sqlite', path: FILE }],
      }),
    );
    await openWorkbench(page, { url: t.url });
    await openView(page, 'aantje');
    await expect.poll(() => outline(page)).toEqual([`${LAKE} : sqlite`]);

    const row = treeRow(page, LAKE);
    const disconnectedTooltip = await hoverWithShot(t, row);
    expect(disconnectedTooltip).toContain(`File: ${FILE}`);
    expect(isGreen(await iconColor(row)), 'the icon of a disconnected connection is not green').toBe(false);
    await t.shot('disconnected');

    await clickInlineAction(row, 'Connect');
    await expect.poll(() => outline(page)).toEqual(atSchemas(`${LAKE} : sqlite · DuckLake 1.1 · @13`));
    await waitForStatus(`${LAKE} · DuckLake 1.1 · latest (@13)`);
    await expect
      .poll(async () => isGreen(await iconColor(row)), {
        message: 'the icon of a connected connection is green',
      })
      .toBe(true);
    await t.shot('connected');
  });

  await t.step('tooltips: table, nested column, column comment, view', async () => {
    await expandNode(page, 'sales');
    await expandNode(page, 'Tables', { level: 3 });
    await expandNode(page, 'orders');
    await expandNode(page, 'Columns');
    await expandNode(page, 'customer');

    const orders = await hoverWithShot(t, treeRow(page, 'orders'), 'tooltip-table');
    expect(orders).toContain('Rows in data files (inlined rows not included): 2');

    const nested = await hoverWithShot(t, treeRow(page, 'name', { level: 7 }), 'tooltip-nested-column');
    expect(nested).toContain('sales.orders.customer.name');

    const amount = await hoverWithShot(t, treeRow(page, 'amount'), 'tooltip-column-comment');
    expect(amount).toContain('Net amount in EUR');

    await expandNode(page, 'Views', { level: 3 });
    // The folder Macros is always there, also in a schema without macros, and says so.
    await expandNode(page, 'Macros', { level: 3 });
    await expect(treeRow(page, 'No macros.')).toBeVisible();
    await collapseNode(page, 'Macros', { level: 3 });
    const view = await hoverWithShot(t, treeRow(page, 'big_orders'), 'tooltip-view');
    expect(view).toContain('SELECT * FROM sales.orders WHERE (amount > 1)');
    await hoverWithShot(t, treeRow(page, LAKE), 'tooltip-connection');
  });

  await t.step('a view has only the folder Columns, and no question yet', async () => {
    await expandNode(page, 'big_orders');
    await expect(page.locator('.monaco-dialog-box'), 'expanding the view asks nothing').toHaveCount(0);
    // The rows below the view: everything after it that is deeper than the view.
    const all = await readTree(page);
    const start = all.findIndex((row) => row.label === 'big_orders');
    const end = all.findIndex((row, index) => index > start && row.level <= all[start].level);
    expect(all.slice(start + 1, end === -1 ? undefined : end).map((row) => row.label)).toEqual(['Columns']);
    await collapseNode(page, 'big_orders');
  });

  await t.step(
    'a table lists the leaves Statistics and History above its folders; History opens on click',
    async () => {
      await collapseNode(page, 'Columns');
      const children = (await readTree(page)).filter((row) => row.level === 5);
      expect(children.map(({ label }) => label)).toEqual(['Statistics', 'History', 'Columns']);

      // A click on History opens the schema history of the table in a panel.
      await treeRow(page, 'History').locator('.label-name').click();
      await expect(page.getByRole('tab', { name: /^Schema History of sales.orders · / })).toBeVisible();
      await t.shot('table-history');
    },
  );

  await t.step(
    'Snapshots lists the snapshots with their changes; the connection has no Storage folder',
    async () => {
      // The list renders only the rows in view: close the schemas, so that the 14 snapshots fit.
      await collapseNode(page, 'sales');
      await expandNode(page, 'Snapshots');
      await expect
        .poll(async () =>
          (await readTree(page))
            .filter((row) => row.level === 3 && /^@\d+$/.test(row.label))
            .map(({ label }) => label),
        )
        .toEqual(SNAPSHOTS);
      // A snapshot is the transaction: it lists the objects that it changed, each with the action.
      await expandNode(page, '@2');
      await expect(treeRow(page, 'sales.orders', { level: 4 }).locator('.label-description')).toHaveText(
        'Created table',
      );
      await t.shot('snapshots-folder');

      // The storage of the catalog is a report panel (reports.mjs), not a folder of the tree.
      await collapseNode(page, 'Snapshots');
      await expect(treeRow(page, 'Storage')).toHaveCount(0);
    },
  );

  await t.step(
    'status bar: pinned snapshot, and a click opens the picker on the shown snapshot',
    async () => {
      await aantjeStatus(page).click();
      await pick(page, '@9', { title: `Snapshot of "${LAKE}"` });
      await waitForStatus(`${LAKE} · DuckLake 1.1 · @9 (pinned)`);
      await hoverWithShot(t, aantjeStatus(page));
      await t.shot('status-bar-pinned', await around(page, aantjeStatus(page).locator('..'), { margin: 40 }));

      // The picker opens on the snapshot that is shown, so Enter keeps it.
      await aantjeStatus(page).click();
      await expect.poll(() => activePickLabel(page)).toBe('@9');
      await pick(page, 'Latest');
      await waitForStatus(`${LAKE} · DuckLake 1.1 · latest (@13)`);
    },
  );

  await t.step(
    'Show Catalog at Snapshot: Latest and 14 snapshots, newest first; @5 shows the old tree',
    async () => {
      await collapseAll();
      await runCommand(page, 'aantje: Show Catalog at Snapshot...');
      const entries = await allPickEntries(page);
      expect(entries.map(({ label }) => label)).toEqual(['Latest', ...SNAPSHOTS]);
      await t.shot('snapshot-picker');
      await pick(page, '@5');

      await waitForStatus(`${LAKE} · DuckLake 1.1 · @5 (pinned)`);
      await expandNode(page, LAKE);
      await expandNode(page, 'main');
      await expandNode(page, 'sales');
      // Both schemas have the folder Tables, also main, which has no table at @5: the second one is that of sales.
      const salesTables = treeRow(page, 'Tables', { level: 3 }).nth(1);
      await salesTables.locator('.label-name').click();
      await expect
        .poll(() => outline(page))
        .toEqual([
          `${LAKE} : sqlite · DuckLake 1.1 · @5 (pinned)`,
          '  main',
          '    Tables',
          '    Views',
          '    Macros',
          '  sales',
          '    Tables',
          '      orders',
          '      tmp',
          '    Views',
          '    Macros',
          '  Snapshots',
        ]);
      // The tree shows no row count; the tooltip of a table has it, as it was at the pinned snapshot.
      expect(await hoverText(page, treeRow(page, 'orders'))).toContain(
        'Rows in data files (inlined rows not included): 3',
      );
      // The view was created at snapshot 7: the folder Views of sales is still there at @5, and says that it is empty.
      const salesViews = treeRow(page, 'Views', { level: 3 }).nth(1);
      await salesViews.locator('.label-name').click();
      await expect(treeRow(page, 'No views.')).toBeVisible();
      await salesViews.locator('.label-name').click();
      await t.shot('snapshot-5');

      await runCommand(page, 'aantje: Show Catalog at Snapshot...');
      await pick(page, 'Latest');
      await waitForStatus(`${LAKE} · DuckLake 1.1 · latest (@13)`);
      await expect.poll(() => outline(page)).toContain('      orders');
      await expect(treeRow(page, 'tmp')).toHaveCount(0);
      await t.shot('snapshot-latest');
    },
  );

  await t.step('Search Catalog: the match is revealed and selected, parents opened', async () => {
    await collapseAll();
    await runCommand(page, 'aantje: Search Catalog...');
    await expect.poll(() => q.labels()).toEqual(['main.plain', 'sales.big_orders', 'sales.orders']);
    await q.input.fill('ord');
    await expect.poll(() => q.labels()).toEqual(expect.arrayContaining(['sales.orders', 'sales.big_orders']));
    await t.shot('search-ord');
    await pick(page, 'sales.orders');

    await expect(treeRow(page, 'orders')).toHaveAttribute('aria-selected', 'true');
    await t.shot('search-revealed-table');

    await runCommand(page, 'aantje: Search Catalog...');
    await q.input.fill('big');
    await pick(page, 'sales.big_orders');
    await expect(treeRow(page, 'big_orders')).toHaveAttribute('aria-selected', 'true');
    await t.shot('search-revealed-view');

    await runCommand(page, 'aantje: Search Catalog...');
    await q.input.fill('plain');
    await pick(page, 'main.plain');
    await expect(treeRow(page, 'plain')).toHaveAttribute('aria-selected', 'true');
  });

  await t.step('Copy Qualified Name and Copy DDL put the exact text on the clipboard', async () => {
    await expandNode(page, 'orders');
    await expandNode(page, 'Columns');
    await expandNode(page, 'customer');
    const copied = async (target, item, expected) => {
      await writeClipboard(page, '');
      await chooseFromContextMenu(page, target, item);
      await expect.poll(() => readClipboard(page)).toBe(expected);
    };

    await copied(
      treeRow(page, 'name', { level: 7 }),
      'Copy Qualified Name',
      '"sales"."orders"."customer"."name"',
    );
    const table = treeRow(page, 'orders');
    await copied(table, 'Copy Qualified Name', '"sales"."orders"');
    await copied(
      table,
      'Copy DDL',
      [
        'CREATE TABLE "sales"."orders" (',
        '  "id" INTEGER NOT NULL,',
        '  "customer" STRUCT("name" VARCHAR, "tags" VARCHAR[]),',
        '  "attrs" MAP(VARCHAR, INTEGER),',
        '  "amount" DECIMAL(10,2) DEFAULT 0,',
        '  "created" TIMESTAMP',
        ');',
      ].join('\n'),
    );
    await copied(
      treeRow(page, 'big_orders'),
      'Copy DDL',
      'CREATE VIEW "sales"."big_orders" AS SELECT * FROM sales.orders WHERE (amount > 1);',
    );
    await copied(treeRow(page, 'sales'), 'Copy Qualified Name', '"sales"');
    await t.shot('copied');
  });

  await t.step('Disconnect and Connect: the pinned snapshot is forgotten', async () => {
    await runCommand(page, 'aantje: Show Catalog at Snapshot...');
    await pick(page, '@5');
    await waitForStatus(`${LAKE} · DuckLake 1.1 · @5 (pinned)`);

    const row = treeRow(page, LAKE);
    await clickInlineAction(row, 'Disconnect');
    await expect.poll(() => outline(page)).toEqual([`${LAKE} : sqlite`]);
    await waitForStatus(`${LAKE} · disconnected`);
    await t.shot('disconnected-again');

    await clickInlineAction(row, 'Connect');
    await expect.poll(() => outline(page)).toEqual(atSchemas(`${LAKE} : sqlite · DuckLake 1.1 · @13`));
    await waitForStatus(`${LAKE} · DuckLake 1.1 · latest (@13)`);
  });

  await t.step(
    'Refresh in the title bar and inline picks up snapshots that were committed meanwhile',
    async () => {
      const first = await commitSchema(t.server, FILE, 'extra');
      expect(first).toBe(14);
      // Nothing changes until the user refreshes: the catalog was read when it was connected.
      expect(await outline(page)).toEqual(atSchemas(`${LAKE} : sqlite · DuckLake 1.1 · @13`));

      await titleAction(page, 'Refresh').click();
      await expect
        .poll(() => outline(page))
        .toEqual(atSchemas(`${LAKE} : sqlite · DuckLake 1.1 · @14`, ['extra', 'main', 'sales']));
      await t.shot('refreshed-title-bar');

      // Inline on the folder Tables of a schema: the whole connection is read again, so the newest snapshot shows
      // everywhere, and the folder stays expanded. Collapse All first: earlier steps opened nodes below the folder.
      await collapseAll();
      await expandNode(page, LAKE);
      await expandNode(page, 'sales');
      await expandNode(page, 'Tables', { level: 3 });
      await commitSchema(t.server, FILE, 'more');
      await clickInlineAction(treeRow(page, 'Tables', { level: 3 }), 'Refresh');
      await expect
        .poll(() => outline(page))
        .toEqual([
          `${LAKE} : sqlite · DuckLake 1.1 · @15`,
          '  extra',
          '  main',
          '  more',
          '  sales',
          '    Tables',
          '      orders',
          '    Views',
          '    Macros',
          '  Snapshots',
        ]);
      // The schema and its folders Views and Macros have the button, too.
      for (const row of [
        treeRow(page, 'sales'),
        treeRow(page, 'Views', { level: 3 }),
        treeRow(page, 'Macros', { level: 3 }),
      ]) {
        await row.hover();
        await expect(row.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
      }
      await collapseNode(page, 'sales');
      await expect
        .poll(() => outline(page))
        .toEqual(atSchemas(`${LAKE} : sqlite · DuckLake 1.1 · @15`, ['extra', 'main', 'more', 'sales']));

      // A pinned snapshot stays pinned when the connection is refreshed.
      await runCommand(page, 'aantje: Show Catalog at Snapshot...');
      await pick(page, '@14');
      await waitForStatus(`${LAKE} · DuckLake 1.1 · @14 (pinned)`);
      await commitSchema(t.server, FILE, 'last');
      await clickInlineAction(treeRow(page, LAKE), 'Refresh');
      await expect
        .poll(async () => (await outline(page))[0])
        .toBe(`${LAKE} : sqlite · DuckLake 1.1 · @14 (pinned)`);
      // The tooltip of a row whose inline button was just clicked stays off until the pointer has been on another row.
      await treeRow(page, 'extra').hover();
      await page.waitForTimeout(500);
      expect(await hoverText(page, treeRow(page, LAKE))).toContain('Latest snapshot: @16');
      await waitForStatus(`${LAKE} · DuckLake 1.1 · @14 (pinned)`);
      await runCommand(page, 'aantje: Show Catalog at Snapshot...');
      await pick(page, 'Latest');
      await waitForStatus(`${LAKE} · DuckLake 1.1 · latest (@16)`);
    },
  );

  await t.step('Test Connection from the context menu', async () => {
    await dismissNotifications(page);
    await chooseFromContextMenu(page, treeRow(page, LAKE), 'Test Connection');
    expect(await waitForNotification(page, /^The connection .* works\./)).toContain('latest snapshot 16');
    await t.shot('test-connection');
  });

  await t.step('Edit Connection: change the name, keep the rest', async () => {
    await dismissNotifications(page);
    await chooseFromContextMenu(page, treeRow(page, LAKE), 'Edit Connection...');
    await expect(q.input).toHaveValue(LAKE);
    await t.shot('edit-connection-name');
    await input(page, 'Renamed lake', { title: `Edit Connection "${LAKE}" (1/3)` });
    await expect(q.input).toHaveValue(FILE);
    await page.keyboard.press('Enter');
    await pick(page, 'No', { title: `Edit Connection "${LAKE}" (3/3): ${READ_ONLY}` });

    await waitForNotification(page, /^Saved connection "Renamed lake"/);
    expect(await connections()).toEqual([
      { id: 'fixture-lake', name: 'Renamed lake', kind: 'sqlite', path: FILE },
    ]);
    await waitForStatus('Renamed lake · DuckLake 1.1 · latest (@16)');
    await t.shot('edit-connection-saved');
  });

  await t.step(
    'Edit Connection: the read-only question is saved and offered again as it was answered',
    async () => {
      await dismissNotifications(page);
      const edit = async (answer, expectedFirst) => {
        await chooseFromContextMenu(page, treeRow(page, 'Renamed lake'), 'Edit Connection...');
        await input(page, 'Renamed lake', { title: 'Edit Connection "Renamed lake" (1/3)' });
        await input(page, FILE, { title: 'Edit Connection "Renamed lake" (2/3)' });
        await expect(q.title).toHaveText(`Edit Connection "Renamed lake" (3/3): ${READ_ONLY}`);
        expect((await q.labels())[0], 'the stored answer comes first').toBe(expectedFirst);
        await pick(page, answer);
        await waitForNotification(page, /^Saved connection "Renamed lake"/);
        await dismissNotifications(page);
      };
      await edit('Yes', 'No');
      expect(await connections()).toEqual([
        { id: 'fixture-lake', name: 'Renamed lake', kind: 'sqlite', path: FILE, readOnly: true },
      ]);
      await edit('No', 'Yes');
      expect(await connections()).toEqual([
        { id: 'fixture-lake', name: 'Renamed lake', kind: 'sqlite', path: FILE },
      ]);
    },
  );

  await t.step(
    'two connections: the status bar and the commands act on the selected connection',
    async () => {
      await collapseAll();
      await dismissNotifications(page);
      await addSqliteConnection('Old lake', FILE_V1_0);
      await waitForNotification(page, /^Saved connection "Old lake"/);
      // A connection that was just added does not take over: the commands keep acting on the connected one.
      await waitForStatus('Renamed lake · DuckLake 1.1 · latest (@16)');

      await treeRow(page, 'Old lake').locator('.label-name').click();
      await expect
        .poll(() => outline(page))
        .toEqual([
          'Renamed lake : sqlite · DuckLake 1.1 · @16',
          ...atSchemas('Old lake : sqlite · DuckLake 1.0 · @13'),
        ]);
      await waitForStatus('Old lake · DuckLake 1.0 · latest (@13)');

      // Show Catalog at Snapshot without a node: the connection that is selected in the tree.
      await runCommand(page, 'aantje: Show Catalog at Snapshot...');
      await pick(page, '@5', { title: 'Snapshot of "Old lake"' });
      await waitForStatus('Old lake · DuckLake 1.0 · @5 (pinned)');
      expect(await outline(page)).toContain('Renamed lake : sqlite · DuckLake 1.1 · @16');
      await t.shot('two-connections-old-pinned');

      // Search at the pinned snapshot of the selected connection.
      await runCommand(page, 'aantje: Search Catalog...');
      await expect.poll(() => q.labels()).toEqual(['sales.orders', 'sales.tmp']);
      await q.input.fill('tmp');
      await pick(page, 'sales.tmp');
      await expect(treeRow(page, 'tmp')).toHaveAttribute('aria-selected', 'true');

      // Select the other connection: the status bar and the search follow.
      await treeRow(page, 'Renamed lake').locator('.label-name').click();
      await waitForStatus('Renamed lake · DuckLake 1.1 · latest (@16)');
      await runCommand(page, 'aantje: Search Catalog...');
      await expect.poll(() => q.labels()).toEqual(['main.plain', 'sales.big_orders', 'sales.orders']);
      await t.shot('two-connections-search-renamed');
      await page.keyboard.press('Escape');

      // And back: the status bar item opens the picker of the connection it shows.
      await treeRow(page, 'Old lake').locator('.label-name').click();
      await waitForStatus('Old lake · DuckLake 1.0 · @5 (pinned)');
      await aantjeStatus(page).click();
      await pick(page, 'Latest', { title: 'Snapshot of "Old lake"' });
      await waitForStatus('Old lake · DuckLake 1.0 · latest (@13)');
      await t.shot('two-connections-back-to-latest');
    },
  );

  await t.step('themes: the aantje icon in the Activity Bar and the tree in Dark+ and Light+', async () => {
    await expandNode(page, 'Renamed lake');
    const tab = activityBarTab(page, 'aantje');
    const crop = () => around(page, activityBar(page), { through: tab, margin: 6 });
    const contrast = {};

    for (const [name, kind] of [
      ['Dark+', 'dark'],
      ['Light+', 'light'],
    ]) {
      await setColorTheme(page, { name, kind });
      await openView(page, 'aantje');
      const slug = name.replace('+', '-plus').toLowerCase();
      contrast[`${slug} selected`] = await activityIconContrast(page, tab);
      await t.shot(`theme-${slug}-tree`);
      await t.shot(`theme-${slug}-activity-bar-selected`, await crop());
      await openView(page, 'Explorer');
      contrast[`${slug} not selected`] = await activityIconContrast(page, tab);
      await t.shot(`theme-${slug}-activity-bar`, await crop());
      await openView(page, 'aantje');
    }
    console.log(`  icon contrast: ${JSON.stringify(contrast)}`);
    for (const [state, { ratio }] of Object.entries(contrast)) {
      expect(ratio, `contrast of the aantje icon (${state}) against the Activity Bar`).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  await t.step('a catalog that cannot be opened: error state, retry, test, remove', async () => {
    await collapseAll();
    await dismissNotifications(page);
    await addSqliteConnection('Missing lake', MISSING);
    const failure = await waitForNotification(page, /^Connection test failed:/);
    console.log(`  failure text: ${failure}`);
    expect(failure).toContain('missing.sqlite');
    await t.shot('add-failed-test');
    await pick(page, 'Save anyway', { title: 'The connection test failed' });

    const row = treeRow(page, 'Missing lake');
    await row.locator('.label-name').click();
    await expect(row.locator('.label-description')).toHaveText('sqlite · connection failed');
    await waitForStatus('Missing lake · connection failed');
    expect(await hoverWithShot(t, row, 'tooltip-error')).toContain('missing.sqlite');

    await clickInlineAction(row, 'Connect');
    const message = await waitForNotification(page, /^Cannot connect to "Missing lake"/);
    console.log(`  connect failure text: ${message}`);
    await t.shot('connect-failed');

    await dismissNotifications(page);
    await chooseFromContextMenu(page, row, 'Test Connection');
    await waitForNotification(page, /^Connection test failed:/);

    const remove = () => chooseFromContextMenu(page, row, 'Remove Connection');
    const asked = 'Remove the connection "Missing lake"?';
    await remove();
    await answerDialog(page, 'Cancel', { message: asked });
    await expect(row).toBeVisible();
    await remove();
    await answerDialog(page, 'Remove', { message: asked });
    await expect(row).toHaveCount(0);
    expect((await connections()).map(({ name }) => name)).toEqual(['Renamed lake', 'Old lake']);
    // The status bar returns to a connection that exists.
    await expect.poll(statusBar).toMatch(/^(Renamed lake|Old lake) · /);
  });

  await t.step('Remove Connection for the last ones: the welcome view with Add Connection', async () => {
    for (const name of ['Old lake', 'Renamed lake']) {
      await chooseFromContextMenu(page, treeRow(page, name), 'Remove Connection');
      await answerDialog(page, 'Remove', { message: `Remove the connection "${name}"?` });
      await expect(treeRow(page, name)).toHaveCount(0);
    }
    expect(await connections()).toEqual([]);
    await expect(sidebar(page)).toContainText('No DuckLake connection yet.');
    await expect(aantjeStatus(page)).toHaveCount(0);
    await t.shot('welcome-view');

    await sidebar(page).getByRole('button', { name: 'Add Connection', exact: true }).click();
    await expect(q.title).toHaveText('Add Connection: where is the DuckLake metadata stored?');
    await q.input.press('Escape');
    await expect(q.widget).toBeHidden();
    // The same wizard from the title bar.
    await titleAction(page, 'Add Connection...').click();
    await expect(q.title).toHaveText('Add Connection: where is the DuckLake metadata stored?');
    await q.input.press('Escape');
  });
}
