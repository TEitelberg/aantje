import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MACHINE_SETTINGS,
  PROJECT,
  chooseFromSubmenu,
  expandNode,
  expect,
  openView,
  openWorkbench,
  pick,
  runCommand,
  treeRow,
} from '../lib/index.mjs';
import { webview } from '../lib/data-features-support.mjs';
import { cardValues, drawnCanvases, readTable, watchCspViolations } from '../lib/panels.mjs';
import { inlineActionLabels } from '../lib/tree-features-helpers.mjs';

export const title =
  'Statistics: report of shop.events, charts, the four themes and the content security policy';

const LAKE = 'History';
const CATALOG = `${PROJECT}/history.sqlite`;
const TAB = `Statistics of shop.events @56 · ${LAKE}`;

/** The variables of VS Code that the statistics report reads for its colours. */
const CHART_VARIABLES = [
  '--vscode-editor-background',
  '--vscode-charts-foreground',
  '--vscode-charts-lines',
  '--vscode-charts-blue',
  '--vscode-charts-green',
  '--vscode-charts-purple',
  '--vscode-charts-yellow',
  '--vscode-charts-orange',
  '--vscode-charts-red',
];

const THEMES = [
  { name: 'Dark+', bodyClass: /vscode-dark/ },
  { name: 'Light+', bodyClass: /vscode-light/ },
  { name: 'Dark High Contrast', bodyClass: /vscode-high-contrast(?!-light)/ },
  { name: 'Light High Contrast', bodyClass: /vscode-high-contrast-light/ },
];

export default async function statistics(t) {
  const { page, server } = t;
  const frame = webview(page);
  const tab = page.getByRole('tab', { name: TAB });
  const violations = watchCspViolations(page);

  const openTab = async (label) => {
    await frame.locator('.tab', { hasText: new RegExp(`^${label}$`) }).click();
    await expect(frame.locator('.tab[aria-selected="true"]')).toHaveText(label);
  };
  /** Exactly one chart, with something drawn on it. */
  const drawnChart = async () => {
    await expect
      .poll(async () => (await drawnCanvases(frame)).map(({ drawn }) => drawn > 1000))
      .toEqual([true]);
  };

  await t.step('prepare: the history catalog as a connection, connected, and the table in view', async () => {
    // The harness copies only the top-level fixtures into the project; the history fixture is in the read-only mount.
    const { code, stderr } = await server.exec(`cp /e2e/fixtures/history/history.sqlite ${CATALOG}`);
    expect(code, stderr).toBe(0);
    const settings = await server.readJson(MACHINE_SETTINGS);
    await server.writeFile(
      MACHINE_SETTINGS,
      JSON.stringify({
        ...settings,
        'aantje.connections': [{ id: 'history', name: LAKE, kind: 'sqlite', path: CATALOG }],
      }),
    );
    await openWorkbench(page, { url: t.url });
    await openView(page, 'aantje');
    await treeRow(page, LAKE).click();
    await page.keyboard.press('ArrowRight');
    await expandNode(page, 'shop');
    await expandNode(page, 'Tables');
    await expandNode(page, 'events');
  });

  await t.step('the leaf Statistics has the button, and a click on it opens the Overview', async () => {
    const folder = treeRow(page, 'Statistics');
    expect(await inlineActionLabels(folder)).toEqual(['Statistics']);
    await folder.locator('.label-name').click();
    await expect(tab).toHaveCount(1);
    await expect(frame.locator('h1')).toHaveText('shop.events statistics', { timeout: 60_000 });
    const cards = await cardValues(frame);
    expect([cards.Files, cards.Size, cards.Rows, cards['Small files']]).toEqual([
      '9',
      '6.2 KB',
      '52',
      '100 %',
    ]);
    await drawnChart();
    await t.shot('overview-light');
  });

  await t.step(
    'the Reports submenu of the table reveals the same panel and opens no second one',
    async () => {
      await chooseFromSubmenu(page, treeRow(page, 'events'), 'Reports', 'Statistics');
      await expect(tab).toHaveCount(1);
      await expect(tab).toHaveAttribute('aria-selected', 'true');
    },
  );

  await t.step(
    'Columns, Partitioning and Growth show the columns, the partitions and the history',
    async () => {
      await openTab('Columns');
      expect((await readTable(frame)).map((row) => row.slice(0, 2))).toEqual([
        ['id', 'int32'],
        ['kind', 'varchar'],
        ['ts', 'timestamp'],
        ['amount', 'decimal(10,2)'],
      ]);

      await openTab('Partitioning');
      await expect(frame.locator('h2')).toContainText('kind, month(ts)');
      await drawnChart();

      await openTab('Growth');
      await drawnChart();
      // The tooltip of ECharts is HTML in the page: it must work under the policy of the page.
      const box = await frame.locator('.chart').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
      await expect(frame.locator('.chart').getByText(/^@\d+/).first()).toBeVisible();
      await t.shot('growth-tooltip-light');
      await openTab('Overview');
      await drawnChart();
    },
  );

  const palettes = {};
  for (const { name, bodyClass } of THEMES) {
    await t.step(`the theme ${name}: the variables exist and the charts are drawn again`, async () => {
      await runCommand(page, 'Preferences: Color Theme');
      await pick(page, name);
      await expect(frame.locator('body')).toHaveClass(bodyClass);
      palettes[name] = await frame.locator('body').evaluate((body, variables) => {
        const style = getComputedStyle(body);
        return Object.fromEntries(
          variables.map((variable) => [variable, style.getPropertyValue(variable).trim()]),
        );
      }, CHART_VARIABLES);
      expect(
        Object.entries(palettes[name]).filter(([, value]) => value === ''),
        `chart variables without a value in ${name}`,
      ).toEqual([]);
      // The tab and the data stay; the chart is drawn anew without a reload.
      await expect(tab).toHaveCount(1);
      await openTab('Overview');
      await drawnChart();
      await t.shot(`overview-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`);
      await openTab('Partitioning');
      await drawnChart();
      await t.shot(`partitioning-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`);
      await openTab('Growth');
      await drawnChart();
      await t.shot(`growth-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`);
    });
  }

  await t.step(
    'the content security policy of the page was not violated, and the palettes are on record',
    async () => {
      await writeFile(join(t.out, 'statistics-palettes.json'), `${JSON.stringify(palettes, undefined, 2)}\n`);
      expect(violations).toEqual([]);
    },
  );
}
