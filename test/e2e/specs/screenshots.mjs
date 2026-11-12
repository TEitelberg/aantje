import {
  MACHINE_SETTINGS,
  activeTab,
  answerDialog,
  chooseFromContextMenu,
  chooseFromSubmenu,
  dismissNotifications,
  expandNode,
  expect,
  openView,
  openWorkbench,
  runCommand,
  setColorTheme,
  treeRow,
} from '../lib/index.mjs';
import { installHistoryFixture, runTool, webview } from '../lib/data-features-support.mjs';
import { cardValues, expectDrawnCharts, panelTab, showPanel } from '../lib/panels.mjs';
import { forgetRun, readResults } from '../lib/sql-editor-support.mjs';
import { aantjeStatusText, waitForConnectedMenu } from '../lib/tree-features-helpers.mjs';

export const title =
  'Screenshots: the window only, one editor tab at a time, with the menus open, in a light and a dark theme';

// What this spec writes is meant for the documentation. The files are named
// screenshots-<nn>-<what-it-shows>-<theme>.png; copy them to media/ as workbench-<what-it-shows>.png.

const LAKE = 'History';
const THEMES = [
  { name: 'Light 2026', kind: 'light' },
  { name: 'Dark 2026', kind: 'dark' },
];

export default async function screenshots(t) {
  const { page, server } = t;
  const frame = webview(page);
  const lake = () => treeRow(page, LAKE);
  const events = () => treeRow(page, 'events');
  let theme = 'light';

  /** The screenshot is the browser window of the workbench: no browser frame, nothing of the test around it. */
  const shot = async (what, { menuOpen = false } = {}) => {
    // The command palette that clears the notifications would close an open menu: that was done in closeEditors.
    if (!menuOpen) await dismissNotifications(page);
    // Away from every element, so that no tooltip or hover effect is in the image; an open menu closes when the
    // pointer leaves it, so there the pointer stays on the menu.
    if (!menuOpen) await page.mouse.move(1000, 12);
    await page.waitForTimeout(400);
    await t.shot(`${what}-${theme}`);
  };

  /** Closes every editor, so that the window shows one tab at most; a SQL document that was run is not saved. */
  const closeEditors = async () => {
    await runCommand(page, 'View: Close All Editors');
    const dialog = page.locator('.monaco-dialog-box');
    if (await dialog.isVisible()) await answerDialog(page, "Don't Save");
    await expect(page.locator('.editor-group-container .tab')).toHaveCount(0);
    await dismissNotifications(page);
  };

  /** Opens a report from the Reports submenu of a row and waits until its page has a heading. */
  const open = async (row, label, tab) => {
    await chooseFromSubmenu(page, row, 'Reports', label);
    await showPanel(page, tab);
    await expect(frame.locator('h1')).toBeVisible({ timeout: 60_000 });
  };

  /** Right click on a row, then the submenu (it opens beside the menu); both stay open for the screenshot. */
  const openMenus = async (row, submenu) => {
    await row.click({ button: 'right' });
    const menu = page.locator('.monaco-menu').first();
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: submenu, exact: true }).click();
    await expect(page.locator('.monaco-menu').nth(1)).toBeVisible();
    // The pointer would show nothing in the image, but a hover tooltip could; keep it on the menu.
    await page.waitForTimeout(300);
  };
  const closeMenus = async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.monaco-menu')).toHaveCount(0);
  };

  // 2:1 (1440 x 720 CSS pixels, 2880 x 1440 in the image), the format of the pictures for the documentation.
  await page.setViewportSize({ width: 1440, height: 720 });

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
    // Only the window of the product: no secondary side bar, no panel at the bottom.
    await runCommand(page, 'View: Toggle Secondary Side Bar Visibility');
    await lake().click();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => aantjeStatusText(page)).toBe(`${LAKE} · DuckLake 1.1 · latest (@56)`);
    await waitForConnectedMenu(page, lake());
    await expandNode(page, 'shop');
    await expandNode(page, 'Tables', { level: 3 });
    await expect(events()).toBeVisible();
  });

  for (const { name, kind } of THEMES) {
    theme = kind;

    await t.step(`${name}: set the theme`, async () => {
      await setColorTheme(page, { name, kind });
    });

    await t.step(`${name}: context menu of a table with the Script as submenu open`, async () => {
      await closeEditors();
      await open(events(), 'Statistics', `shop.events statistics @56 · ${LAKE}`);
      await expect(frame.locator('.card').first()).toBeVisible();
      await openMenus(events(), 'Script as');
      await shot('table-context-menu-with-script-as-submenu', { menuOpen: true });
      await closeMenus();
    });

    await t.step(`${name}: context menu of the lake with the Reports submenu open`, async () => {
      await closeEditors();
      await open(lake(), 'Storage Report', `Storage · ${LAKE}`);
      await expect(frame.locator('.card').first()).toBeVisible();
      await openMenus(lake(), 'Reports');
      await shot('lake-context-menu-with-reports-submenu', { menuOpen: true });
      await closeMenus();
    });

    await t.step(`${name}: storage report, the tables with their chart`, async () => {
      await closeEditors();
      await open(lake(), 'Storage Report', `Storage · ${LAKE}`);
      await frame.getByRole('tab', { name: 'Tables', exact: true }).click();
      await expectDrawnCharts(frame, 1);
      await shot('storage-report-tables-chart');
    });

    await t.step(`${name}: snapshot report, the chart and the list of snapshots`, async () => {
      await closeEditors();
      await open(lake(), 'Snapshot Report', `Snapshot report · ${LAKE}`);
      await expectDrawnCharts(frame, 1);
      await shot('snapshot-report-chart-and-snapshot-list');
    });

    await t.step(`${name}: maintenance advisor with its recommendations`, async () => {
      await closeEditors();
      await open(lake(), 'Maintenance Advisor', `Maintenance Advisor · ${LAKE}`);
      await expect(frame.locator('.card-label', { hasText: 'Merge candidates' })).toBeVisible({
        timeout: 60_000,
      });
      expect((await cardValues(frame))['Merge candidates']).toBe('1');
      await expect(frame.locator('details.finding').first()).toHaveAttribute('open', '');
      await shot('maintenance-advisor-recommendations');
    });

    await t.step(`${name}: SQL editor with a query on a table and the result grid below`, async () => {
      await closeEditors();
      await chooseFromContextMenu(page, events(), 'New Query');
      await expect(activeTab(page)).toContainText('Untitled-');
      await forgetRun(page);
      await page.keyboard.press('F5');
      await expect
        .poll(async () => (await readResults(page)).run, { timeout: 120_000 })
        .toMatch(/^Completed in /);
      expect((await readResults(page)).result.rows.length).toBeGreaterThan(0);
      await expect(panelTab(page, /results/)).toBeVisible();
      await shot('sql-editor-query-and-result-grid');
    });
  }
}
