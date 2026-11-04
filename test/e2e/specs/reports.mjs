import {
  MACHINE_SETTINGS,
  activeTab,
  chooseFromSubmenu,
  collapseNode,
  contextMenuItems,
  diffEditorTexts,
  editorText,
  expandNode,
  expect,
  openView,
  openWorkbench,
  outline,
  pick,
  runCommand,
  submenuItems,
  treeRow,
} from '../lib/index.mjs';
import {
  installHistoryFixture,
  readGrid,
  runTool,
  webview,
  changesTab,
} from '../lib/data-features-support.mjs';
import {
  cardValues,
  expectDrawnCharts,
  openAsMarkdown,
  panelTab,
  readTable,
  showPanel,
  watchCspViolations,
} from '../lib/panels.mjs';
import { queryStatusText } from '../lib/sql-editor-support.mjs';
import { aantjeStatusText, waitForConnectedMenu } from '../lib/tree-features-helpers.mjs';

export const title =
  'Reports: the Reports submenu and the panels Properties, Storage, Snapshot report, Activity, Schema History, Dependencies and Maintenance Advisor';

const LAKE = 'History';

const THEMES = [
  { name: 'Dark+', bodyClass: /vscode-dark/ },
  { name: 'Light+', bodyClass: /vscode-light/ },
  { name: 'Dark High Contrast', bodyClass: /vscode-high-contrast(?!-light)/ },
];

// The panels that the steps above opened, with the number of charts that each draws.
const PANELS = [
  { title: `Properties · ${LAKE}`, slug: 'properties', charts: 0 },
  { title: `Storage · ${LAKE}`, slug: 'storage', charts: 1 },
  { title: `Statistics of shop.events @56 · ${LAKE}`, slug: 'statistics', charts: 0 },
  { title: `Snapshot Report · ${LAKE}`, slug: 'snapshot-report', charts: 1 },
  { title: `Activity · ${LAKE}`, slug: 'activity', charts: 2 },
  { title: `Schema History of main.evolved · ${LAKE}`, slug: 'schema-history', charts: 0 },
  { title: 'Dependencies of shop.events', slug: 'dependencies', charts: 0 },
  { title: `Maintenance Advisor · ${LAKE}`, slug: 'advisor', charts: 0 },
];

/** The text of a SQL statement list: the lines of a script that are no comment. */
const statementsOf = (text) => text.split('\n').filter((line) => line !== '' && !line.startsWith('--'));

export default async function reports(t) {
  const { page, server } = t;
  const frame = webview(page);
  const violations = watchCspViolations(page);
  const lake = () => treeRow(page, LAKE);
  const status = () => aantjeStatusText(page);
  // Every script and Markdown document that is opened is a new untitled document.
  let untitled = 0;
  const nextUntitled = async () => {
    untitled += 1;
    await expect(activeTab(page)).toContainText(`Untitled-${untitled}`);
  };
  /** Opens a report from the Reports submenu of a row and waits until its page has a heading. */
  const open = async (row, label, tab) => {
    await chooseFromSubmenu(page, row, 'Reports', label);
    await expect(panelTab(page, tab)).toHaveCount(1);
    await showPanel(page, tab);
    await expect(frame.locator('h1')).toBeVisible({ timeout: 60_000 });
  };
  /** The Markdown document of the panel; counts it as an untitled document. */
  const markdown = async (tab) => {
    const text = await openAsMarkdown(page, frame, tab);
    untitled += 1;
    return text;
  };

  await t.step('prepare: the history catalog as a connection, connected, with shop in view', async () => {
    const catalog = await installHistoryFixture(server);
    await runTool(server, ['prefetch'], { timeoutSeconds: 300 });
    const settings = await server.readJson(MACHINE_SETTINGS);
    await server.writeFile(
      MACHINE_SETTINGS,
      JSON.stringify({
        ...settings,
        'aantje.connections': [{ id: 'history', name: LAKE, kind: 'sqlite', path: catalog }],
      }),
    );
    await openWorkbench(page, { url: t.url });
    await openView(page, 'aantje');
    await runCommand(page, 'View: Toggle Secondary Side Bar Visibility');
    await lake().click();
    await page.keyboard.press('ArrowRight');
    await expect.poll(status).toBe(`${LAKE} · DuckLake 1.1 · latest (@56)`);
    await waitForConnectedMenu(page, lake());
    await expandNode(page, 'shop');
    await expandNode(page, 'Tables', { level: 3 });
    await expandNode(page, 'Views', { level: 3 });
    await expandNode(page, 'Macros', { level: 3 });
    await expect(treeRow(page, 'events')).toBeVisible();
    await expect(treeRow(page, 'gross')).toBeVisible();
  });

  await t.step('the Reports submenu offers the reports of each kind of node, and nothing else', async () => {
    expect(await submenuItems(page, lake(), 'Reports')).toEqual([
      'Snapshot Report',
      'Properties',
      'Storage Report',
      'Maintenance Advisor',
      'Activity',
      'Check Health',
      'Dependencies',
      'Growth',
    ]);
    expect(await submenuItems(page, treeRow(page, 'events'), 'Reports')).toEqual([
      'Statistics',
      'Schema History',
      'Check Table Health',
      'Dependencies',
      'Growth',
    ]);
    expect(await submenuItems(page, treeRow(page, 'big_events'), 'Reports')).toEqual(['Dependencies']);
    expect(await submenuItems(page, treeRow(page, 'gross'), 'Reports')).toEqual(['Dependencies']);
    // A schema has the reports that can be narrowed to it; a folder, a snapshot and a column have no reports, and the
    // report entries are in no other menu.
    expect(await contextMenuItems(page, treeRow(page, 'shop'))).toEqual([
      'Copy Qualified Name',
      'New Query',
      'Script as',
      'Maintenance',
      'Reports',
    ]);
    expect(await submenuItems(page, treeRow(page, 'shop'), 'Reports')).toEqual([
      'Maintenance Advisor',
      'Check Health',
      'Storage Report',
      'Growth',
      'Activity',
      'Dependencies',
    ]);
    expect(await contextMenuItems(page, treeRow(page, 'Tables', { level: 3 }))).toEqual(['Script as']);
    expect(await contextMenuItems(page, lake())).not.toContain('Properties');
    await t.shot('reports-submenu');
  });

  await t.step('Properties: cards, the metadata with its filter, Open as Markdown', async () => {
    const tab = `Properties · ${LAKE}`;
    await open(lake(), 'Properties', tab);
    await expect(frame.locator('h1')).toHaveText('Properties');
    await expect(frame.locator('.subtitle')).toHaveText(`${LAKE} · 5 metadata entries`);
    const cards = await cardValues(frame);
    expect(cards['DuckLake version']).toBe('1.1');
    expect(cards['Created by']).toMatch(/^DuckDB /);
    expect(cards['Data path'], 'the data path is in the metadata table, not a card').toBeUndefined();
    expect(cards.Encrypted).toBe('no');
    expect(cards.Snapshots).toBe('57');
    expect(cards['First snapshot']).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/);
    expect(cards['Latest snapshot']).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/);
    const keys = async () => (await readTable(frame, '.metadata table')).map((row) => [row[0], row[2]]);
    expect(await keys()).toEqual([
      ['created_by', 'global'],
      ['data_path', 'global'],
      ['encrypted', 'global'],
      ['version', 'global'],
      ['data_inlining_row_limit', 'table 10'],
    ]);
    await t.shot('properties');

    // The filter finds text in the key, the value or the scope, whatever the case.
    const filter = frame.getByRole('searchbox');
    await filter.fill('TABLE 10');
    await expect.poll(keys).toEqual([['data_inlining_row_limit', 'table 10']]);
    await filter.fill('no such entry');
    await expect(frame.locator('.empty')).toHaveText('No metadata entry matches "no such entry".');
    await filter.fill('inlining');
    await expect.poll(keys).toEqual([['data_inlining_row_limit', 'table 10']]);

    // Open as Markdown writes the document with the filter that is set.
    const text = await markdown(tab);
    const lines = text.split('\n');
    expect(lines[0]).toBe(`# Properties of ${LAKE}`);
    expect(lines).toContain('| DuckLake version | `1.1` |');
    expect(lines).toContain('| Encrypted | no |');
    expect(lines).toContain('| Snapshots | 57 |');
    expect(lines).toContain('## Metadata');
    expect(text).toContain('Filter: `inlining`. 1 of 5 entries match.');
    expect(lines.some((line) => /^\| `data_inlining_row_limit` \| `10` \| `table \d+` \|$/.test(line))).toBe(
      true,
    );
    expect(text, 'the filter is applied to the entries').not.toContain('`created_by`');
    await t.shot('properties-markdown');
  });

  await t.step('Properties: the button opens the Storage report of the same lake', async () => {
    await showPanel(page, `Properties · ${LAKE}`);
    await frame.getByRole('button', { name: 'Show Storage Report', exact: true }).click();
    await expect(panelTab(page, `Storage · ${LAKE}`)).toHaveCount(1);
    await expect(frame.locator('h1')).toHaveText('Storage');
  });

  await t.step(
    'Storage: cards, the bars and the list of the tables, a table action, Open as Markdown',
    async () => {
      const tab = `Storage · ${LAKE}`;
      await showPanel(page, tab);
      await expect(frame.locator('.subtitle')).toContainText(`Snapshot @56 · ${LAKE} · read `);
      const cards = await cardValues(frame);
      expect(cards['Data path']).toBe('/home/coder/project/history/sqlite-files/');
      expect(cards.Encrypted).toBe('no');
      expect(cards.Snapshot).toBe('@56');
      expect(cards['Data files']).toBe('19');
      expect(cards['Delete files']).toBe('1');
      expect(cards.Rows).toBe('69');
      // Five files wait for the cleanup: the four that the compaction replaced and one delete file.
      expect(cards['Scheduled for deletion']).toBe('5');
      await expect(frame.locator('.scheduled')).toContainText('5 files scheduled');
      await t.shot('storage-overview');

      await frame.getByRole('tab', { name: 'Tables', exact: true }).click();
      await expect(frame.getByRole('tab', { name: 'Tables', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      // The bars are drawn on a canvas; the list under them has a row for every table with files.
      await expectDrawnCharts(frame, 1);
      const names = async () => (await readTable(frame)).map((row) => row[0].replace(/^⚠\s*/, ''));
      await expect
        .poll(async () => [...(await names())].sort())
        .toEqual([
          'main.evolved',
          'shop.audit',
          'shop.customers',
          'shop.events',
          'shop.log',
          'shop.notes',
          'shop.readings',
        ]);
      const events = (await readTable(frame)).find((row) => row[0].includes('shop.events'));
      expect(events.slice(1, 5)).toEqual([
        expect.stringMatching(/^9$/),
        expect.any(String),
        expect.any(String),
        '52',
      ]);
      await frame.getByRole('searchbox').fill('log');
      await expect.poll(names).toEqual(['shop.log']);
      await frame.getByRole('searchbox').fill('');
      await t.shot('storage-tables');

      // A table action: select the table, then open its statistics report.
      await frame.getByRole('button', { name: 'shop.events', exact: false }).first().click();
      await expect(frame.locator('.selection h3')).toHaveText('shop.events');
      await frame.getByRole('button', { name: /^Show Statistics/ }).click();
      await expect(panelTab(page, `Statistics of shop.events @56 · ${LAKE}`)).toHaveCount(1);
      await showPanel(page, `Statistics of shop.events @56 · ${LAKE}`);
      await expect(frame.locator('h1')).toHaveText('shop.events statistics', { timeout: 60_000 });
      await t.shot('storage-opens-statistics');

      // The scripts that the page offers are documents; nothing runs.
      await showPanel(page, tab);
      await frame.getByRole('button', { name: /^Expire Snapshots/ }).click();
      await nextUntitled();
      expect(statementsOf(await editorText(page))).toEqual([
        "CALL ducklake_expire_snapshots('lake', older_than => now() - INTERVAL 30 DAY, dry_run => true);",
      ]);
      await expect.poll(() => queryStatusText(page)).toBe(`${LAKE} · read/write`);

      await showPanel(page, tab);
      await frame.getByRole('tab', { name: 'Growth', exact: true }).click();
      await expectDrawnCharts(frame, 1);
      await expect(frame.locator('h2').last()).toContainText('The last');
      const growth = await readTable(frame);
      expect(growth.some((row) => row.includes('Compaction'))).toBe(true);
      await t.shot('storage-growth');

      const text = await markdown(tab);
      expect(text.split('\n')[0]).toBe(`# Storage of ${LAKE}`);
      expect(text).toContain('## Largest tables');
      expect(text).toContain('| `shop.events` | 9 |');
    },
  );

  await t.step(
    'Snapshot report: the swimlane chart, a selected snapshot, Rows changed and Latest',
    async () => {
      const tab = `Snapshot Report · ${LAKE}`;
      await open(lake(), 'Snapshot Report', tab);
      await expect(frame.locator('.subtitle')).toHaveText(`${LAKE} · 57 snapshots read, latest @56`);
      await expectDrawnCharts(frame, 1);
      await expect(frame.locator('.detail')).toContainText('Select a snapshot in the chart or in the list');
      await t.shot('snapshot-report');

      // A click in the plot selects the snapshot nearest to it.
      const box = await frame.locator('.chart').first().boundingBox();
      await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
      await expect(frame.locator('.detail h2')).toHaveText(/^@\d+ · \d{4}-\d\d-\d\d /);
      const clicked = (await frame.locator('.detail h2').textContent()).match(/^@(\d+)/)[1];
      await expect(frame.locator(`tr.selected button.pick`)).toHaveText(`@${clicked}`);

      // @17 updated shop.customers: the detail pane names the table and offers its rows.
      await frame.locator('button.pick', { hasText: /^@17$/ }).click();
      await expect(frame.locator('.detail h2')).toHaveText(/^@17 · /);
      await expect(frame.locator('.detail .table-row .name')).toHaveText(['shop.customers']);
      await frame.getByRole('button', { name: /^Rows changed/ }).click();
      await expect(changesTab(page, `shop.customers changes @16 → @17 · ${LAKE}`)).toBeVisible();
      await expect.poll(async () => (await readGrid(page)).rows.length).toBe(2);
      expect((await readGrid(page)).kinds).toEqual(['update-before', 'update-after']);
      await t.shot('snapshot-report-rows-changed');

      // Show catalog pins the tree; Latest makes it follow the newest snapshot again.
      await showPanel(page, tab);
      await frame.getByRole('button', { name: 'Show catalog at @17', exact: true }).click();
      await expect.poll(status).toBe(`${LAKE} · DuckLake 1.1 · @17 (pinned)`);
      await showPanel(page, tab);
      await frame.getByRole('button', { name: 'Show latest snapshot', exact: true }).click();
      await expect.poll(status).toBe(`${LAKE} · DuckLake 1.1 · latest (@56)`);

      const text = await markdown(tab);
      expect(text.split('\n')[0]).toBe(`# Snapshot report of ${LAKE}`);
    },
  );

  await t.step(
    'Activity: figures, authors, a filter that applies to everything, Open as Markdown',
    async () => {
      const tab = `Activity · ${LAKE}`;
      await open(lake(), 'Activity', tab);
      await expect(frame.locator('.subtitle')).toHaveText(`${LAKE} · 57 snapshots read, latest @56`);
      const cards = await cardValues(frame);
      expect(cards.Snapshots).toBe('57');
      expect(cards.Authors).toBe('2');
      expect(cards['Tables changed']).toBe('8');
      await expectDrawnCharts(frame, 2);
      expect(await readTable(frame, 'table:has(th:text("Latest message"))')).toEqual([
        ['(no author)', '56', expect.any(String), expect.any(String), ''],
        ['tillmann', '1', expect.any(String), expect.any(String), 'Nightly import'],
      ]);
      await t.shot('activity');

      await frame.getByLabel('Author').selectOption({ label: 'tillmann' });
      await expect(frame.locator('button.pick')).toHaveText(['@25']);
      await frame.locator('button.pick', { hasText: '@25' }).click();
      await expect(frame.locator('.detail h2')).toHaveText(/^@25 · /);
      await expect(frame.locator('.detail')).toContainText('shop.customers');
      await frame.getByLabel('Author').selectOption({ label: 'All authors' });
      await expect(frame.locator('button.pick')).toHaveCount(57);
      // A click on a table of the ranking filters the whole report to it.
      await frame.locator('button.table-pick', { hasText: /^shop\.customers$/ }).click();
      await expect(frame.locator('button.pick')).toHaveCount(8);
      await t.shot('activity-filtered');

      const text = await markdown(tab);
      expect(text.split('\n')[0]).toBe(`# Activity of ${LAKE}`);
      expect(text).toContain('Nightly import');
    },
  );

  await t.step('Schema History of main.evolved: the matrix cells and Compare Schema', async () => {
    await collapseNode(page, 'shop');
    await expandNode(page, 'main');
    await expandNode(page, 'Tables', { level: 3 });
    const tab = `Schema History of main.evolved · ${LAKE}`;
    await open(treeRow(page, 'evolved'), 'Schema History', tab);
    const cells = async () =>
      frame.locator('button.cell').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')));
    await expect.poll(async () => (await cells()).length).toBeGreaterThan(10);
    const labels = await cells();
    for (const expected of [
      'title (formerly name), snapshot 29: ↔ renamed: name → title',
      'n, snapshot 30: Δ type: int32 → int64',
      'extra, snapshot 28: + added: float64',
      'extra, snapshot 31: − dropped',
      'info.c, snapshot 32: + added: float64',
      'flag, snapshot 34: = default: false → true',
    ]) {
      expect(labels, expected).toContain(expected);
    }
    await t.shot('schema-history');

    await frame.getByRole('button', { name: /^title \(formerly name\), snapshot 29/ }).click();
    await expect(frame.locator('.detail h2')).toHaveText(/^@29 · /);
    await frame
      .locator('.detail')
      .getByRole('button', { name: /^previous @28/ })
      .click();
    await expect(page.getByRole('tab', { name: 'main.evolving: @28 ↔ @29' })).toBeVisible();
    const diff = await diffEditorTexts(page);
    expect(diff.original).toContain('"name" VARCHAR');
    expect(diff.modified).toContain('"title" VARCHAR');
    await t.shot('schema-history-compare');
    await collapseNode(page, 'main');
    await expandNode(page, 'shop');
  });

  await t.step('Dependencies of shop.events: used by, depends on, and Script as DROP', async () => {
    await open(treeRow(page, 'events'), 'Dependencies', 'Dependencies of shop.events');
    await expect(frame.locator('.subtitle')).toContainText(`${LAKE} · snapshot @56`);
    const items = () => frame.locator('.objects [role=option]').allTextContents();
    await expect
      .poll(items)
      .toEqual([
        expect.stringMatching(/^◧ shop\.big_events · view /),
        expect.stringMatching(/^ƒ▦ shop\.recent_events · table macro /),
      ]);
    await expect(frame.locator('.impact')).toContainText('If you drop shop.events');
    await t.shot('dependencies');

    await frame.getByRole('button', { name: 'Depends on', exact: true }).click();
    await expect(frame.locator('.empty')).toHaveText('shop.events uses no table, view or macro.');
    await frame.getByRole('button', { name: 'Used by', exact: true }).click();
    await expect.poll(async () => (await items()).length).toBe(2);

    // The drop script of the object that would break is a document of the connection; nothing runs.
    await frame.getByRole('option', { name: /shop\.big_events/ }).click();
    await frame
      .locator('.detail')
      .getByRole('button', { name: /^Script as DROP/ })
      .click();
    await nextUntitled();
    expect(await editorText(page)).toBe(
      '-- Drops the view. Run it in a read/write SQL session.\nDROP VIEW "shop"."big_events";',
    );
    await expect.poll(() => queryStatusText(page)).toBe(`${LAKE} · read/write`);

    // The report of a view: what it depends on.
    await expandNode(page, 'Views', { level: 3 });
    await open(treeRow(page, 'big_events'), 'Dependencies', 'Dependencies of shop.big_events');
    await frame.getByRole('button', { name: 'Depends on', exact: true }).click();
    await expect.poll(items).toEqual([expect.stringMatching(/^▦ shop\.events · table /)]);
  });

  await t.step('Maintenance Advisor: figures, a recommendation, Open script', async () => {
    const tab = `Maintenance Advisor · ${LAKE}`;
    await open(lake(), 'Maintenance Advisor', tab);
    await expect(frame.locator('.subtitle')).toContainText('dry runs only, nothing is changed');
    await expect(frame.locator('.card-label', { hasText: 'Merge candidates' })).toBeVisible({
      timeout: 60_000,
    });
    const cards = await cardValues(frame);
    expect(cards['Snapshots to expire']).toBe('0');
    expect(cards['Merge candidates']).toBe('1');
    expect(cards['Rewrite candidates']).toBe('1');
    // The first recommendation is open; the others are cards that open on a click.
    const first = frame.locator('details.finding').first();
    await expect(first.locator('summary')).toHaveText('1. Merge 9 small files of shop.events');
    await expect(first).toHaveAttribute('open', '');
    await expect(first).toContainText('Impact: low');
    await t.shot('advisor');

    await frame
      .getByRole('button', { name: /^Open script: Open the Merge Adjacent Files script for shop\.events/ })
      .click();
    await nextUntitled();
    expect(statementsOf(await editorText(page))).toEqual([
      "CALL ducklake_merge_adjacent_files('lake', 'events', schema => 'shop');",
    ]);
    await expect.poll(() => queryStatusText(page)).toBe(`${LAKE} · read/write`);

    await showPanel(page, tab);
    const text = await markdown(tab);
    expect(text.split('\n')[0]).toBe(`# Maintenance advisor of ${LAKE}`);
    expect(text).toMatch(/Merge 9 small files of .*shop.events/);
  });

  for (const { name, bodyClass } of THEMES) {
    await t.step(
      `the theme ${name}: every panel is drawn again, readable, and the policy of the page holds`,
      async () => {
        await runCommand(page, 'Preferences: Color Theme');
        await pick(page, name);
        for (const tab of PANELS) {
          await showPanel(page, tab.title);
          await expect(frame.locator('body')).toHaveClass(bodyClass);
          await expect(frame.locator('h1')).toBeVisible();
          // A page with charts draws them again with the colors of the new theme, without a reload.
          if (tab.charts > 0) {
            await expectDrawnCharts(frame, tab.charts);
          }
          const slug = name
            .toLowerCase()
            .replace(/[^a-z]+/g, '-')
            .replace(/-$/, '');
          await t.shot(`theme-${slug}-${tab.slug}`);
        }
      },
    );
  }

  await t.step('no content security policy message appeared in the console', async () => {
    expect(violations).toEqual([]);
    expect(await outline(page)).toContain(`${LAKE} : sqlite · DuckLake 1.1 · @56`);
  });
}
