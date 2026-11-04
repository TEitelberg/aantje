import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MACHINE_SETTINGS,
  PROJECT,
  chooseFromContextMenu,
  chooseFromSubmenu,
  collapseNode,
  dismissNotifications,
  expandNode,
  expect,
  focusEditor,
  openView,
  openWorkbench,
  pick,
  runCommand,
  setEditorText,
  treeRow,
} from '../lib/index.mjs';
import { installHistoryFixture, runTool, webview } from '../lib/data-features-support.mjs';
import { GUTTER, WIDTHS, layoutProblems, measureLayout, setWebviewWidth } from '../lib/layout.mjs';
import { expectDrawnCharts, panelTab, showPanel } from '../lib/panels.mjs';
import { forgetRun, readResults, openResultTab } from '../lib/sql-editor-support.mjs';
import { aantjeStatusText, waitForConnectedMenu } from '../lib/tree-features-helpers.mjs';

export const title =
  'Layout: every report panel, the data grid and the results panel keep the same gutter to the left and right edge at three widths, without horizontal scroll bar';

const LAKE = 'History';
const BROKEN = 'History broken';
const BROKEN_DIR = `${PROJECT}/history-broken`;
const NODE = '/usr/lib/code-server/lib/node';
const HIGH_CONTRAST = 'Dark High Contrast';

// Prints the files that the newest snapshot of shop.log needs (the health spec loses one of them for an error card).
const CURRENT_FILES = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const rows = db.prepare(
  "SELECT f.path FROM ducklake_data_file f JOIN ducklake_table t ON t.table_id = f.table_id AND t.end_snapshot IS NULL WHERE t.table_name = ? AND f.end_snapshot IS NULL ORDER BY f.data_file_id",
).all(process.argv[3]);
console.log(JSON.stringify(rows.map((row) => row.path)));
`;

// The panels in the order of the first pass; the high contrast pass shows each of them once more.
const TABS = [
  { title: `Properties · ${LAKE}`, scene: 'properties' },
  { title: `Storage · ${LAKE}`, scene: 'storage' },
  { title: `Statistics of shop.events @56 · ${LAKE}`, scene: 'statistics' },
  { title: `Snapshot Report · ${LAKE}`, scene: 'snapshot-report' },
  { title: `shop.customers changes @16 → @17 · ${LAKE}`, scene: 'changes-grid' },
  { title: `Activity · ${LAKE}`, scene: 'activity' },
  { title: `Schema History of main.evolved · ${LAKE}`, scene: 'schema-history' },
  { title: 'Dependencies of shop.events', scene: 'dependencies' },
  { title: `Maintenance Advisor · ${LAKE}`, scene: 'advisor' },
  { title: `Health · ${LAKE}`, scene: 'health', not: 'broken' },
  { title: `Health · ${BROKEN}`, scene: 'health-broken' },
  { title: `shop.events (top 1000) · ${BROKEN} @56`, scene: 'data-grid' },
];

export default async function layout(t) {
  const { page, server } = t;
  const frame = webview(page);
  const lake = (name = LAKE) => treeRow(page, name);
  const records = [];

  /** Brings a panel to the front by the exact start of its tab title (`not` tells apart `Health · A` and `Health · A b`). */
  const showTab = async (title, not) => {
    let tab = page.getByRole('tab', { name: title });
    if (not) tab = tab.filter({ hasNotText: not });
    await expect(tab).toHaveCount(1);
    if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  };

  /** Opens a report from the Reports submenu of a row and waits until its page has a heading. */
  const open = async (row, label, tab) => {
    await chooseFromSubmenu(page, row, 'Reports', label);
    await expect(panelTab(page, tab)).toHaveCount(1);
    await showPanel(page, tab);
    await expect(frame.locator('h1')).toBeVisible({ timeout: 60_000 });
  };

  /**
   * Measures the page in its current state at every width, saves a screenshot of the panel for each, and keeps the
   * problems for the end of the spec so that one run lists all of them.
   */
  const scene = async (label, { widths = WIDTHS, theme = 'light' } = {}) => {
    for (const target of widths) {
      const reached = await setWebviewWidth(page, frame, target);
      await page.waitForTimeout(400);
      // A chart is drawn again after a resize; wait for it, and measure what is there if it does not settle.
      let m = await measureLayout(frame);
      for (let attempt = 0; attempt < 10 && m.canvases.some((c) => !c.inside); attempt++) {
        await page.waitForTimeout(300);
        m = await measureLayout(frame);
      }
      const problems = layoutProblems(m);
      records.push({ scene: label, theme, target, reached, ...m, problems });
      await t.shot(
        `${label}-${theme === 'light' ? '' : 'hc-'}${target}`,
        page.locator('iframe.webview.ready:visible'),
      );
    }
  };

  await t.step('prepare: the history catalog, a copy that lost a file, both connections', async () => {
    const catalog = await installHistoryFixture(server);
    await runTool(server, ['prefetch'], { timeoutSeconds: 300 });
    const copy = await server.exec(
      `rm -rf ${BROKEN_DIR} && mkdir -p ${BROKEN_DIR} && cp -r ${PROJECT}/history/sqlite-files ${PROJECT}/history/history.sqlite ${BROKEN_DIR}/ && chmod -R u+w ${BROKEN_DIR}`,
    );
    expect(copy.code, copy.stderr).toBe(0);
    await runTool(server, [
      'sqlite',
      `${BROKEN_DIR}/history.sqlite`,
      `UPDATE ducklake_metadata SET value = '${BROKEN_DIR}/sqlite-files/' WHERE key = 'data_path'`,
    ]);
    await server.writeFile('/tmp/layout-current-files.mjs', CURRENT_FILES);
    const listed = await server.exec(
      `${NODE} --no-warnings /tmp/layout-current-files.mjs ${BROKEN_DIR}/history.sqlite log`,
    );
    expect(listed.code, listed.stderr).toBe(0);
    const lostFile = JSON.parse(listed.stdout).at(-1);
    expect((await server.exec(`rm ${BROKEN_DIR}/sqlite-files/shop/log/${lostFile}`)).code).toBe(0);

    const settings = await server.readJson(MACHINE_SETTINGS);
    await server.writeFile(
      MACHINE_SETTINGS,
      JSON.stringify({
        ...settings,
        'aantje.connections': [
          { id: 'history', name: LAKE, kind: 'sqlite', path: catalog },
          { id: 'history-broken', name: BROKEN, kind: 'sqlite', path: `${BROKEN_DIR}/history.sqlite` },
        ],
      }),
    );
    await openWorkbench(page, { url: t.url });
    await openView(page, 'aantje');
    await runCommand(page, 'View: Toggle Secondary Side Bar Visibility');
    await lake().click();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => aantjeStatusText(page)).toBe(`${LAKE} · DuckLake 1.1 · latest (@56)`);
    await waitForConnectedMenu(page, lake());
    await expandNode(page, 'shop');
    await expandNode(page, 'Tables', { level: 3 });
    await expect(treeRow(page, 'events')).toBeVisible();
  });

  await t.step('Properties: cards and the table, and the empty state of its filter', async () => {
    await open(lake(), 'Properties', `Properties · ${LAKE}`);
    await expect(frame.locator('.metadata table')).toBeVisible();
    await scene('properties');
    await frame.getByRole('searchbox').fill('no such entry');
    await expect(frame.locator('.empty')).toBeVisible();
    await scene('properties-empty');
  });

  await t.step(
    'Storage: overview, tables with the chart, the selection pane, an empty filter, growth',
    async () => {
      await open(lake(), 'Storage Report', `Storage · ${LAKE}`);
      await expect(frame.locator('.card').first()).toBeVisible();
      await scene('storage-overview');
      await frame.getByRole('tab', { name: 'Tables', exact: true }).click();
      await expectDrawnCharts(frame, 1);
      await scene('storage-tables');
      await frame.getByRole('button', { name: 'shop.events', exact: false }).first().click();
      await expect(frame.locator('.selection h3')).toHaveText('shop.events');
      await scene('storage-selection');
      await frame.getByRole('searchbox').fill('no such table');
      await expect(frame.locator('.empty')).toBeVisible();
      await scene('storage-tables-empty');
      await frame.getByRole('searchbox').fill('');
      await frame.getByRole('tab', { name: 'Growth', exact: true }).click();
      await expectDrawnCharts(frame, 1);
      await scene('storage-growth');
    },
  );

  await t.step(
    'Statistics: the four tabs, with the empty states of a table that is not partitioned',
    async () => {
      await open(treeRow(page, 'events'), 'Statistics', `Statistics of shop.events @56 · ${LAKE}`);
      await expect(frame.locator('.card').first()).toBeVisible();
      await scene('statistics');
      for (const label of ['Columns', 'Partitioning', 'Growth']) {
        await frame.locator('.tab', { hasText: new RegExp(`^${label}$`) }).click();
        await expect(frame.locator('.tab[aria-selected="true"]')).toHaveText(label);
        await scene(`statistics-${label.toLowerCase()}`);
      }
    },
  );

  await t.step(
    'Snapshot report: chart and list, the table filter, a detail pane, the grid of its changes',
    async () => {
      const tab = `Snapshot Report · ${LAKE}`;
      await open(lake(), 'Snapshot Report', tab);
      await expectDrawnCharts(frame, 1);
      await scene('snapshot-report');
      await frame.locator('.filter summary').click();
      await expect(frame.locator('.choices')).toBeVisible();
      await scene('snapshot-filter');
      await frame.locator('.filter summary').click();
      await frame.locator('button.pick', { hasText: /^@17$/ }).click();
      await expect(frame.locator('.detail h2')).toHaveText(/^@17 · /);
      await scene('snapshot-detail');
      await frame.getByRole('button', { name: /^Rows changed/ }).click();
      await expect(
        page.getByRole('tab', { name: `shop.customers changes @16 → @17 · ${LAKE}` }),
      ).toBeVisible();
      await expect(frame.locator('tbody tr')).toHaveCount(2);
      await scene('changes-grid');
    },
  );

  await t.step('Activity: charts, lists, a detail pane', async () => {
    await open(lake(), 'Activity', `Activity · ${LAKE}`);
    await expectDrawnCharts(frame, 2);
    await scene('activity');
    await frame.locator('button.pick').first().click();
    await expect(frame.locator('.detail h2')).toHaveText(/^@\d+ · /);
    await scene('activity-detail');
  });

  await t.step('Schema History: the matrix and a detail pane', async () => {
    await collapseNode(page, 'shop');
    await expandNode(page, 'main');
    await expandNode(page, 'Tables', { level: 3 });
    await open(treeRow(page, 'evolved'), 'Schema History', `Schema History of main.evolved · ${LAKE}`);
    await expect.poll(() => frame.locator('button.cell').count()).toBeGreaterThan(10);
    await scene('schema-history');
    await frame.getByRole('button', { name: /^title \(formerly name\), snapshot 29/ }).click();
    await expect(frame.locator('.detail h2')).toHaveText(/^@29 · /);
    await scene('schema-history-detail');
    await collapseNode(page, 'main');
    await expandNode(page, 'shop');
  });

  await t.step('Dependencies: the list, the detail pane, an empty state', async () => {
    await open(treeRow(page, 'events'), 'Dependencies', 'Dependencies of shop.events');
    await expect(frame.locator('.objects [role=option]')).toHaveCount(2);
    await scene('dependencies');
    await frame.getByRole('option', { name: /shop\.big_events/ }).click();
    await expect(frame.locator('.detail h2')).toBeVisible();
    await scene('dependencies-detail');
    await frame.getByRole('button', { name: 'Depends on', exact: true }).click();
    await expect(frame.locator('.empty')).toBeVisible();
    await scene('dependencies-empty');
  });

  await t.step('Maintenance Advisor: figures and recommendations', async () => {
    await open(lake(), 'Maintenance Advisor', `Maintenance Advisor · ${LAKE}`);
    await expect(frame.locator('.card-label', { hasText: 'Merge candidates' })).toBeVisible({
      timeout: 60_000,
    });
    await scene('advisor');
  });

  await t.step('Health: a healthy lake, an open finding, an empty filter', async () => {
    await open(lake(), 'Check Health', `Health · ${LAKE}`);
    await expect(frame.getByRole('button', { name: /^Run again/ })).toBeVisible({ timeout: 90_000 });
    await scene('health');
    await frame.locator('.health-finding summary').first().click();
    await scene('health-finding-open');
    await frame.getByRole('searchbox').fill('no such finding');
    await expect(frame.locator('.empty')).toBeVisible();
    await scene('health-empty');
  });

  await t.step('Health of the lake that lost a file: an error card with its details', async () => {
    await collapseNode(page, LAKE);
    await lake(BROKEN).click();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => aantjeStatusText(page)).toBe(`${BROKEN} · DuckLake 1.1 · latest (@56)`);
    await waitForConnectedMenu(page, lake(BROKEN));
    await dismissNotifications(page);
    await open(lake(BROKEN), 'Check Health', `Health · ${BROKEN}`);
    await expect(frame.getByRole('button', { name: /^Run again/ })).toBeVisible({ timeout: 90_000 });
    const error = frame.locator('.health-finding.error');
    await expect(error).toHaveCount(1);
    await error.locator('summary').click();
    await expect(error.locator('dl')).toBeVisible();
    await scene('health-broken');
  });

  await t.step('the data grid: Top 1000 rows of a table with nested columns', async () => {
    await expandNode(page, 'shop');
    await expandNode(page, 'Tables', { level: 3 });
    await dismissNotifications(page);
    await chooseFromContextMenu(page, treeRow(page, 'events'), 'Select Top 1000 Rows');
    await expect(page.getByRole('tab', { name: `shop.events (top 1000) · ${BROKEN} @56` })).toBeVisible();
    await expect(frame.locator('tbody tr').first()).toBeVisible({ timeout: 60_000 });
    await scene('data-grid');
  });

  await t.step('the results panel of the SQL editor: a result, the messages, an error', async () => {
    await chooseFromContextMenu(page, treeRow(page, 'events'), 'New Query');
    await focusEditor(page);
    await forgetRun(page);
    await page.keyboard.press('F5');
    await expect
      .poll(async () => (await readResults(page)).run, { timeout: 60_000 })
      .toMatch(/^Completed in /);
    await scene('results-result');
    await openResultTab(page, 'Messages');
    await scene('results-messages');

    await focusEditor(page);
    await setEditorText(page, 'SELECT 1 AS one;\nSELECT * FROM nope;');
    await forgetRun(page);
    await page.keyboard.press('F5');
    await expect
      .poll(async () => (await readResults(page)).run, { timeout: 60_000 })
      .toMatch(/^Failed after /);
    await openResultTab(page, 'Messages');
    await scene('results-error');
  });

  await t.step(`the theme ${HIGH_CONTRAST}: the results panel and every other panel at 900 px`, async () => {
    await runCommand(page, 'Preferences: Color Theme');
    await pick(page, HIGH_CONTRAST);
    await expect(frame.locator('body')).toHaveClass(/vscode-high-contrast(?!-light)/);
    await scene('results-error', { widths: [900], theme: 'hc' });
    await runCommand(page, 'View: Close Editor');
    for (const { title, scene: label, not } of TABS) {
      await showTab(title, not);
      await expect(frame.locator('h1, table').first()).toBeVisible();
      await scene(label, { widths: [900], theme: 'hc' });
    }
  });

  await t.step('the gutters are the same everywhere and nothing sticks to an edge or overflows', async () => {
    await writeFile(join(t.out, 'layout-measurements.json'), `${JSON.stringify(records, undefined, 2)}\n`);
    const lines = records.flatMap((r) =>
      r.problems.map((problem) => `${r.scene} (${r.theme}, ${r.reached}px): ${problem}`),
    );
    expect(lines).toEqual([]);
    for (const side of ['leftGap', 'topGap']) {
      const gaps = records.map((r) => r[side]);
      expect(Math.max(...gaps) - Math.min(...gaps), `${side} differs between the panels`).toBeLessThanOrEqual(
        2,
      );
      expect(Math.abs(gaps[0] - GUTTER)).toBeLessThanOrEqual(2);
    }
    // Content that fills the width (a table, the tabs, a row of cards) ends exactly at the gutter on the right.
    const rightGaps = new Map();
    for (const r of records) rightGaps.set(r.scene, Math.min(r.rightGap, rightGaps.get(r.scene) ?? Infinity));
    for (const [scene, gap] of rightGaps) {
      expect(
        Math.abs(gap - GUTTER),
        `${scene}: the gap to the right edge at its narrowest width`,
      ).toBeLessThanOrEqual(2);
    }
    expect(new Set(records.map((r) => r.scene)).size).toBeGreaterThanOrEqual(30);
  });
}
