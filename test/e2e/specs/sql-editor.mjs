import {
  MACHINE_SETTINGS,
  PROJECT,
  activeTab,
  chooseFromContextMenu,
  chooseFromSubmenu,
  collapseNode,
  editorText,
  expandNode,
  expect,
  focusEditor,
  openView,
  openWorkbench,
  pick,
  quickInput,
  readTree,
  runCommand,
  setEditorText,
  treeRow,
  waitForNotification,
} from '../lib/index.mjs';
import { DATA, installDataFixture, runTool } from '../lib/data-features-support.mjs';
import {
  forgetRun,
  openResultTab,
  queryStatus,
  queryStatusText,
  readResults,
} from '../lib/sql-editor-support.mjs';

export const title =
  'SQL editor: New Query, Run, results panel bound to its query, errors, writes, read-only sessions, Cancel, completion, snippets, syntax marks and the quick fix of an unknown name';

const LAKE = 'Data lake';
const READ_ONLY_LAKE = 'Read-only lake';
const LONG_QUERY = 'SELECT count(*) FROM range(100000000000)';
const READ_ONLY_TEXT =
  'This is a read-only session: the statement would change the lake. Run "Toggle Read-only Session" to switch this editor to a read-write session.';
const ORDERS_SELECT = `SELECT
  "id",
  "customer",
  "attrs",
  "amount",
  "created"
FROM "sales"."orders"
LIMIT 1000;`;

export default async function sqlEditor(t) {
  const { page, server } = t;
  const q = quickInput(page);
  const cells = (rows) => rows.map((row) => row.map((cell) => cell.text));
  /** Runs the document of the active editor with F5 and waits until the run is over. */
  const runWithKey = async (key) => {
    await forgetRun(page);
    await focusEditor(page);
    await page.keyboard.press(key);
    await expect
      .poll(async () => (await readResults(page)).run)
      .toMatch(/^(Completed in|Cancelled after|Failed after) /);
    return readResults(page);
  };
  const progressToast = page.locator('.notification-toast').filter({ hasText: 'Running SQL on' });
  const newQuery = (label) => chooseFromContextMenu(page, treeRow(page, label), 'New Query');

  await t.step(
    'prepare: the data lake (writable) and a copy of its catalog as a read-only connection',
    async () => {
      await installDataFixture(server);
      // The copy shares the Parquet files of the first one, which a read-only session only reads.
      const copy = await server.exec(`cp ${DATA}/data-catalog.sqlite ${DATA}/readonly-catalog.sqlite`);
      expect(copy.code, copy.stderr).toBe(0);
      await runTool(server, ['prefetch'], { timeoutSeconds: 300 });
      const settings = await server.readJson(MACHINE_SETTINGS);
      await server.writeFile(
        MACHINE_SETTINGS,
        JSON.stringify({
          ...settings,
          'aantje.connections': [
            { id: 'data-lake', name: LAKE, kind: 'sqlite', path: `${DATA}/data-catalog.sqlite` },
            {
              id: 'read-only-lake',
              name: READ_ONLY_LAKE,
              kind: 'sqlite',
              path: `${DATA}/readonly-catalog.sqlite`,
              readOnly: true,
            },
          ],
        }),
      );
      await openWorkbench(page, { url: t.url });
      await openView(page, 'aantje');
      await runCommand(page, 'View: Toggle Secondary Side Bar Visibility');
      await treeRow(page, LAKE).click();
      await page.keyboard.press('ArrowRight');
      await expandNode(page, 'sales');
      await expandNode(page, 'Tables', { level: 3 });
      await expect(treeRow(page, 'orders')).toBeVisible();
    },
  );

  await t.step(
    'New Query on a table opens an untitled SQL document that belongs to the connection',
    async () => {
      await expect(queryStatus(page)).toHaveCount(0);
      await newQuery('orders');
      await expect(activeTab(page)).toContainText('Untitled-1');
      await expect(queryStatus(page)).toBeVisible();
      await expect.poll(() => queryStatusText(page)).toBe(`${LAKE} · read/write`);
      // For a table the document starts with its Script as SELECT.
      expect(await editorText(page)).toBe(ORDERS_SELECT);
      await t.shot('new-query');
    },
  );

  await t.step('F5 runs the document: the results panel shows the Messages tab and the rows', async () => {
    const results = await runWithKey('F5');
    expect(results.tabs).toEqual([
      { label: 'Messages', selected: false },
      { label: 'Result 1 (2 rows)', selected: true },
    ]);
    expect(results.result.sql).toContain('FROM "sales"."orders"');
    expect(results.result.headers).toEqual([
      { name: 'id', type: 'INTEGER' },
      { name: 'customer', type: 'STRUCT("name" VARCHAR, "tags" VARCHAR[])' },
      { name: 'attrs', type: 'MAP(VARCHAR, INTEGER)' },
      { name: 'amount', type: 'DECIMAL(10,2)' },
      { name: 'created', type: 'TIMESTAMP' },
    ]);
    expect(cells(results.result.rows)).toEqual([
      ['1', '{"name":"a","tags":["x"]}', '[{"key":"k","value":1}]', '1.50', '2026-01-01 00:00:00'],
      ['3', 'NULL', 'NULL', '3.00', '2026-01-03 00:00:00'],
    ]);
    expect(results.result.rows[1][1].isNull).toBe(true);
    expect(results.result.hasToolbar).toBe(true);
    expect(results.run).toMatch(/^Completed in [\d,.]+ (ms|s)$/);
    // The panel below the editor carries the name of the document and of the connection.
    const resultsTab = page.getByRole('tab', { name: 'Untitled-1 · Data lake · results' });
    await expect(resultsTab).toBeVisible();
    // It is in a group below the one of the document (same column, lower on the screen), and the editor keeps the focus.
    const documentBox = await activeTab(page).boundingBox();
    const resultsBox = await resultsTab.boundingBox();
    expect(documentBox).not.toBeNull();
    expect(resultsBox).not.toBeNull();
    expect(resultsBox.y).toBeGreaterThan(documentBox.y + documentBox.height);
    expect(Math.abs(resultsBox.x - documentBox.x)).toBeLessThan(2);
    await expect(page.locator('.monaco-editor.focused').first()).toBeVisible();
    await t.shot('results-select');
    // The progress notification of the run goes away with the run.
    await expect(progressToast).toHaveCount(0);

    await openResultTab(page, 'Messages');
    const messages = await readResults(page);
    expect(messages.statements).toHaveLength(1);
    expect(messages.statements[0]).toMatchObject({ number: '1', result: '2 rows' });
    expect(messages.statements[0].time).toMatch(/^[\d,.]+ (ms|s)$/);
    expect(messages.errors).toEqual([]);
  });

  await t.step(
    'Run Statement at Cursor runs one statement; the command from the palette runs them all',
    async () => {
      await setEditorText(page, 'SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT 3 AS c;');
      // The cursor goes to the second statement.
      await page.keyboard.press('Control+Home');
      await page.keyboard.press('ArrowDown');
      const one = await runWithKey('Control+Enter');
      expect(one.tabs.map((tab) => tab.label)).toEqual(['Messages', 'Result 1 (1 row)']);
      expect(cells(one.result.rows)).toEqual([['2']]);
      expect(one.result.headers.map((header) => header.name)).toEqual(['b']);

      await focusEditor(page);
      await runCommand(page, 'aantje: Run Query');
      await expect.poll(async () => (await readResults(page)).tabs.length).toBe(4);
      const all = await readResults(page);
      expect(all.tabs.map((tab) => tab.label)).toEqual([
        'Messages',
        'Result 1 (1 row)',
        'Result 2 (1 row)',
        'Result 3 (1 row)',
      ]);
      expect(cells(all.result.rows)).toEqual([['1']]);
      await openResultTab(page, 'Result 3 (1 row)');
      expect(cells((await readResults(page)).result.rows)).toEqual([['3']]);
      await t.shot('results-three-statements');
    },
  );

  await t.step(
    'a failing second statement: the Messages tab names the error, Go to statement moves the cursor',
    async () => {
      await setEditorText(page, 'SELECT 1 AS a;\nSELECT * FROM sales.nope;\nSELECT 3 AS c;');
      const results = await runWithKey('F5');
      expect(results.run).toMatch(/^Failed after /);
      await openResultTab(page, 'Messages');
      const messages = await readResults(page);
      expect(messages.statements.map(({ number, status, sql }) => [number, status, sql])).toEqual([
        ['1', 'OK', 'SELECT 1 AS a'],
        ['2', 'Error', 'SELECT * FROM sales.nope'],
      ]);
      // The run stops at the error: the third statement is not started and does not appear.
      expect(messages.errors).toHaveLength(1);
      expect(messages.errors[0].message).toContain('nope');
      expect(messages.errors[0].hasGoTo).toBe(true);
      await t.shot('results-error');

      // The cursor is at the end of the third line; the button puts the selection on the failing statement.
      await page
        .frameLocator('iframe.webview.ready:visible')
        .frameLocator('iframe#active-frame')
        .getByRole('button', { name: 'Go to statement' })
        .click();
      await expect(page.locator('[id="workbench.parts.statusbar"]')).toContainText('Ln 2,');
      await expect(page.locator('[id="workbench.parts.statusbar"]')).toContainText('selected)');
    },
  );

  await t.step(
    'a writable session creates and fills a table, and the explorer shows it without a refresh',
    async () => {
      await setEditorText(
        page,
        'CREATE TABLE sales.made (a INTEGER);\nINSERT INTO sales.made VALUES (1), (2);',
      );
      const results = await runWithKey('F5');
      expect(results.run).toMatch(/^Completed in /);
      const messages = await readResults(page);
      expect(messages.statements.map(({ status, result }) => [status, result])).toEqual([
        ['OK', 'Commands completed successfully'],
        ['OK', '2 rows affected'],
      ]);
      // Two commits: the catalog is at snapshot 15 and the new table is in its folder.
      await expect(treeRow(page, 'made')).toBeVisible();
      await expect(treeRow(page, LAKE).locator('.label-description')).toHaveText(
        'sqlite · DuckLake 1.1 · @15',
      );
      expect(
        (await readTree(page)).filter((row) => row.level === 4).map((row) => row.label),
        'the folder Tables lists the new table next to orders',
      ).toEqual(['made', 'orders']);
      await t.shot('table-created');

      await setEditorText(page, 'SELECT a FROM sales.made ORDER BY a');
      const read = await runWithKey('F5');
      expect(cells(read.result.rows)).toEqual([['1'], ['2']]);
    },
  );

  await t.step('a read-only session refuses a write with the friendly text', async () => {
    await collapseNode(page, LAKE);
    await treeRow(page, READ_ONLY_LAKE).click();
    await page.keyboard.press('ArrowRight');
    await expect(treeRow(page, READ_ONLY_LAKE).locator('.label-description')).toHaveText(
      'sqlite · DuckLake 1.1 · @13',
    );
    await newQuery(READ_ONLY_LAKE);
    await expect(activeTab(page)).toContainText('Untitled-2');
    await expect.poll(() => queryStatusText(page)).toBe(`${READ_ONLY_LAKE} · read-only`);
    await setEditorText(page, 'INSERT INTO sales.orders (id) VALUES (9)');
    const results = await runWithKey('F5');
    expect(results.run).toMatch(/^Failed after /);
    expect(results.errors.map((error) => error.message)).toEqual([READ_ONLY_TEXT]);
    await t.shot('read-only-refused');
  });

  await t.step('the status bar menu switches this editor to a writable session and back', async () => {
    await queryStatus(page).click();
    await expect(q.title).toHaveText(`SQL session of ${READ_ONLY_LAKE}`);
    expect(await q.labels()).toEqual([
      'Select Connection...',
      'Switch to a Read/Write Session',
      'Close Session',
    ]);
    await t.shot('query-menu');
    await pick(page, 'Switch to a Read/Write Session');
    await expect.poll(() => queryStatusText(page)).toBe(`${READ_ONLY_LAKE} · read/write`);
    const written = await runWithKey('F5');
    expect(written.statements.map(({ status, result }) => [status, result])).toEqual([
      ['OK', '1 row affected'],
    ]);

    // The profile stays read-only: the command from the palette switches back, and the write is refused again.
    await runCommand(page, 'aantje: Toggle Read-only Session');
    await expect.poll(() => queryStatusText(page)).toBe(`${READ_ONLY_LAKE} · read-only`);
    const refused = await runWithKey('F5');
    expect(refused.errors.map((error) => error.message)).toEqual([READ_ONLY_TEXT]);
    const settings = await server.readJson(MACHINE_SETTINGS);
    expect(settings['aantje.connections'][1].readOnly).toBe(true);
  });

  await t.step('Shift+F5 cancels a query that would run for ever; the session stays usable', async () => {
    await collapseNode(page, READ_ONLY_LAKE);
    await treeRow(page, LAKE).click();
    await page.keyboard.press('ArrowRight');
    await expect(treeRow(page, LAKE).locator('.label-description')).toHaveText('sqlite · DuckLake 1.1 · @15');
    await newQuery(LAKE);
    await expect(activeTab(page)).toContainText('Untitled-3');
    await setEditorText(page, LONG_QUERY);
    await focusEditor(page);
    await page.keyboard.press('F5');
    await expect.poll(async () => (await readResults(page)).run).toBe('Running...');
    await waitForNotification(page, `Running SQL on ${LAKE}...`);
    await t.shot('running');
    await focusEditor(page);
    await page.keyboard.press('Shift+F5');
    await expect.poll(async () => (await readResults(page)).run).toMatch(/^Cancelled after /);
    const results = await readResults(page);
    expect(results.errors.map((error) => error.message)).toEqual(['The statement was cancelled.']);
    await t.shot('cancelled');
    await expect(progressToast).toHaveCount(0);

    await setEditorText(page, 'SELECT 42 AS answer');
    expect(cells((await runWithKey('F5')).result.rows)).toEqual([['42']]);
  });

  await t.step(
    'completion offers the tables of the catalog, only in a document of a connection',
    async () => {
      await server.writeFile(`${PROJECT}/plain.sql`, 'SELECT * FROM sales.');
      await setEditorText(page, 'SELECT * FROM sales.');
      await page.keyboard.press('Control+Space');
      const suggestions = page.locator('.suggest-widget');
      await expect(suggestions).toBeVisible();
      // big_orders is not in any open document, so only the catalog can have put it here.
      await expect(suggestions).toContainText('big_orders');
      await expect(suggestions).toContainText('orders');
      await t.shot('completion');
      await page.keyboard.press('Escape');
      await expect(suggestions).toBeHidden();

      // The same text in a SQL file that belongs to no connection: no table names.
      await page.keyboard.press('Control+p');
      await expect(q.widget).toBeVisible();
      await q.input.fill('plain.sql');
      await expect(q.rows.first()).toContainText('plain.sql');
      await page.keyboard.press('Enter');
      await expect(activeTab(page)).toContainText('plain.sql');
      await expect(queryStatus(page)).toHaveCount(0);
      await focusEditor(page);
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Control+Space');
      await expect(suggestions).toBeVisible();
      await expect(suggestions).not.toContainText('big_orders');
      await t.shot('completion-without-connection');
      await page.keyboard.press('Escape');
    },
  );

  await t.step('a typo is marked in the document of a connection and in no other document', async () => {
    // The file of no connection first, so that its absence of marks means something when the other one has its mark.
    await setEditorText(page, 'SELEC 1');
    await expect(activeTab(page)).toContainText('plain.sql');
    await page.locator('.tab[data-resource-name="Untitled-3"]').click();
    await expect(activeTab(page)).toContainText('Untitled-3');
    await setEditorText(page, 'SELEC 1');
    await expect(page.locator('.monaco-editor .squiggly-error').first()).toBeVisible();

    await page.keyboard.press('Control+Shift+m');
    const problems = page.locator('[id="workbench.parts.panel"]');
    await expect(problems).toContainText('Syntax error at or near "SELEC"');
    await expect(problems).toContainText('aantje');
    // One mark only: the same typo in plain.sql, which belongs to no connection, has none.
    expect(((await problems.innerText()).match(/Syntax error/g) ?? []).length).toBe(1);
    expect(await problems.innerText()).not.toContain('plain.sql');
    await t.shot('syntax-error');

    await setEditorText(page, 'SELECT 1');
    await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(0);
  });

  await t.step(
    'completion inserts a snippet, and the quick fix of an unknown column puts in the nearest name',
    async () => {
      await setEditorText(page, 'SELECT * FROM sales.orders ');
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Control+Space');
      const suggestions = page.locator('.suggest-widget');
      await expect(suggestions).toBeVisible();
      // The next clauses come first; the typed word narrows the list to the AT clause and its snippets.
      await page.keyboard.type('AT');
      await expect(suggestions).toContainText('AT (VERSION => …)');
      const focused = suggestions.locator('.monaco-list-row.focused');
      for (let step = 0; step < 30 && !(await focused.innerText()).includes('AT (VERSION'); step += 1) {
        await page.keyboard.press('ArrowDown');
      }
      await t.shot('snippet');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      expect(await editorText(page)).toBe('SELECT * FROM sales.orders AT (VERSION => )');

      await setEditorText(page, 'SELECT amout FROM sales.orders');
      await expect(page.locator('.monaco-editor .squiggly-warning').first()).toBeVisible();
      await page.keyboard.press('Control+Home');
      for (let step = 0; step < 9; step += 1) await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+.');
      // The menu of the code actions; an empty submenu panel has the same class.
      const fixes = page.locator('.action-widget').filter({ hasText: 'Quick Fix' });
      await expect(fixes).toContainText('Change to amount');
      await t.shot('quick-fix');
      await fixes.getByText('Change to amount').click();
      expect(await editorText(page)).toBe('SELECT amount FROM sales.orders');
      await expect(page.locator('.monaco-editor .squiggly-warning')).toHaveCount(0);
    },
  );

  await t.step(
    'the Macros folder offers a template; running it on a writable session makes the macros appear in the tree',
    async () => {
      await openView(page, 'aantje');
      const folder = treeRow(page, 'Macros', { level: 3 });
      await expandNode(page, 'Macros', { level: 3 });
      await expect(treeRow(page, 'No macros.')).toBeVisible();
      await chooseFromSubmenu(page, folder, 'Script as', 'Script as CREATE');
      await expect(activeTab(page)).toContainText('Untitled-4');
      // The template belongs to the lake of the folder, so that F5 runs it there.
      await expect.poll(() => queryStatusText(page)).toBe(`${LAKE} · read/write`);
      const template = await editorText(page);
      expect(template.startsWith('-- Two examples of a macro in this schema.')).toBe(true);
      const statements = template.split('\n').filter((line) => line !== '' && !line.startsWith('--'));
      expect(statements).toEqual([
        'CREATE MACRO "sales"."add_one"(x) AS x + 1;',
        'CREATE MACRO "sales"."first_rows"(n := 10) AS TABLE SELECT 42 AS answer FROM range(n);',
      ]);
      await t.shot('macro-template');

      const results = await runWithKey('F5');
      expect(results.run).toMatch(/^Completed in /);
      const messages = await readResults(page);
      expect(messages.statements.map(({ status, result }) => [status, result])).toEqual([
        ['OK', 'Commands completed successfully'],
        ['OK', 'Commands completed successfully'],
      ]);
      // Two commits: the explorer reads the lake again and lists the macros, with kind and parameters.
      await expect(treeRow(page, 'add_one')).toBeVisible();
      await expect(treeRow(page, 'No macros.')).toHaveCount(0);
      expect(
        (await readTree(page))
          .filter((row) => row.level === 4 && /^(add_one|first_rows)$/.test(row.label))
          .map(({ label, description }) => [label, description]),
      ).toEqual([
        ['add_one', 'scalar (x)'],
        ['first_rows', 'table (n := 10)'],
      ]);
      await t.shot('macros-created');

      // The calls that the template shows as comments work on the macros it created.
      await setEditorText(page, 'SELECT "sales"."add_one"(41) AS r;\nSELECT * FROM "sales"."first_rows"(2);');
      await runWithKey('F5');
      await openResultTab(page, 'Result 1 (1 row)');
      expect(cells((await readResults(page)).result.rows)).toEqual([['42']]);
      await openResultTab(page, 'Result 2 (2 rows)');
      expect(cells((await readResults(page)).result.rows)).toEqual([['42'], ['42']]);

      // The scripts of a macro are made from the catalog, so they know what was just created.
      // The new document opens in the group that has the focus: the first one, not the results panel beside it.
      await focusEditor(page);
      await chooseFromSubmenu(page, treeRow(page, 'first_rows'), 'Script as', 'Script as DROP');
      await expect(activeTab(page)).toContainText('Untitled-5');
      expect(await editorText(page)).toBe(
        '-- Drops the table macro with all its overloads. Run it in a read/write SQL session.\nDROP MACRO TABLE "sales"."first_rows";',
      );
    },
  );

  await t.step(
    'the results stay with their query: they come forward with it, Hide and Show Results keep the run, and they close with it',
    async () => {
      const queryTab = page.locator('.tab[data-resource-name="Untitled-3"]');
      const resultsTab = page.getByRole('tab', { name: 'Untitled-3 · Data lake · results' });
      const titleButton = (name) =>
        page
          .locator('.editor-group-container')
          .first()
          .locator('.editor-actions')
          .getByRole('button', { name });
      // The results of Untitled-4 ran last; switching to Untitled-3 brings its own results forward in the group below.
      await queryTab.click();
      await expect(activeTab(page)).toContainText('Untitled-3');
      await expect(resultsTab).toHaveAttribute('aria-selected', 'true');
      expect(cells((await readResults(page)).result.rows)).toEqual([['42']]);

      await titleButton('Hide Results').click();
      await expect(resultsTab).toHaveCount(0);
      await t.shot('results-hidden');
      await titleButton('Show Results').click();
      await expect(resultsTab).toBeVisible();
      expect(cells((await readResults(page)).result.rows)).toEqual([['42']]);

      await focusEditor(page);
      await runCommand(page, 'View: Revert and Close Editor');
      await expect(queryTab).toHaveCount(0);
      await expect(resultsTab).toHaveCount(0);
    },
  );
}
