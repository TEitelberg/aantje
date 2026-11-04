import {
  MACHINE_SETTINGS,
  chooseFromSubmenu,
  expandNode,
  expect,
  openView,
  openWorkbench,
  pick,
  runCommand,
  treeRow,
} from '../lib/index.mjs';
import { installHistoryFixture, runTool, webview } from '../lib/data-features-support.mjs';
import {
  cardValues,
  expectDrawnCharts,
  openAsMarkdown,
  panelTab,
  showPanel,
  watchCspViolations,
} from '../lib/panels.mjs';
import { aantjeStatusText, waitForConnectedMenu } from '../lib/tree-features-helpers.mjs';

export const title = 'Growth: the line chart of the rows, the size and the files over the snapshots';

const LAKE = 'History';
const LAKE_TAB = `Growth · ${LAKE}`;
const EVENTS_TAB = `Growth of shop.events · ${LAKE}`;

const THEMES = [
  { name: 'Dark+', bodyClass: /vscode-dark/ },
  { name: 'Light+', bodyClass: /vscode-light/ },
  { name: 'Dark High Contrast', bodyClass: /vscode-high-contrast(?!-light)/ },
];

export default async function growth(t) {
  const { page, server } = t;
  const frame = webview(page);
  const violations = watchCspViolations(page);
  const lake = () => treeRow(page, LAKE);
  const status = () => aantjeStatusText(page);
  /** Opens the report from the Reports submenu of a row and waits until its page has a heading. */
  const open = async (row, tab) => {
    await chooseFromSubmenu(page, row, 'Reports', 'Growth');
    await showPanel(page, tab);
    await expect(frame.locator('h1')).toHaveText('Growth', { timeout: 60_000 });
  };
  const mode = (label) => frame.getByRole('button', { name: label, exact: true });
  // The chart has an aria-label that mentions "table", so the label alone is ambiguous.
  const tableSelect = frame.locator('label.choice select');
  const now = async () => (await cardValues(frame)).Now;

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
    await expect(treeRow(page, 'events')).toBeVisible();
  });

  await t.step('the lake: the key figures, the line on a canvas and a row for every snapshot', async () => {
    await open(lake(), LAKE_TAB);
    const cards = await cardValues(frame);
    expect([cards.Now, cards.Highest, cards['Largest increase'], cards['Largest decrease']]).toEqual([
      '71',
      '71',
      '+40',
      '-2',
    ]);
    await expectDrawnCharts(frame, 1);
    await expect(frame.locator('button.pick')).toHaveCount(57);
    await t.shot('growth-lake');
  });

  await t.step('the value and the x axis: size, files, rows, and the time of the snapshots', async () => {
    await mode('Data size').click();
    await expect.poll(now).toBe('12.7 KB');
    await mode('Data files').click();
    await expect.poll(now).toBe('19');
    await mode('Live rows').click();
    await expect.poll(now).toBe('71');

    await mode('Time').click();
    await expect(mode('Time')).toHaveAttribute('aria-pressed', 'true');
    await expectDrawnCharts(frame, 1);
    await t.shot('growth-time-axis');
    await mode('Snapshots').click();
    await expect(mode('Snapshots')).toHaveAttribute('aria-pressed', 'true');
  });

  await t.step('one table: the rows fall with a delete, and inlined rows are counted', async () => {
    await tableSelect.selectOption({ label: 'shop.customers' });
    await expect.poll(async () => (await cardValues(frame))['Largest decrease']).toBe('-1');
    expect(await now()).toBe('5');
    await expectDrawnCharts(frame, 1);
    await t.shot('growth-customers');

    // shop.notes keeps its 3 rows in the catalog (no file); the delete of one leaves 2.
    await tableSelect.selectOption({ label: 'shop.notes' });
    await expect.poll(now).toBe('2');
    await mode('Data files').click();
    await expect.poll(now).toBe('0');
    await mode('Live rows').click();
  });

  await t.step(
    'the chart: the tooltip names the snapshot under the pointer, a click on a mark selects it',
    async () => {
      await tableSelect.selectOption({ label: 'shop.customers' });
      await expectDrawnCharts(frame, 1);
      const chart = frame.locator('.chart');
      const box = await chart.boundingBox();
      // The tooltip of ECharts is HTML in the page: it has to work under the policy of the page. Find the pointer
      // position at which it names snapshot 25 (the nightly import, with its author and message).
      const names25 = () =>
        chart
          .getByText(/^@25 · /)
          .first()
          .isVisible();
      let first;
      let last;
      for (let at = box.x + 20; at < box.x + box.width - 20; at += 2) {
        await page.mouse.move(at, box.y + box.height / 2);
        if (await names25()) {
          first ??= at;
          last = at;
        } else if (first !== undefined) {
          break;
        }
      }
      expect(first, 'the tooltip never named @25').toBeDefined();
      // The tooltip names a snapshot over a band around its mark: click in the middle of the band, on the mark.
      const x = (first + last) / 2;
      await page.mouse.move(x, box.y + box.height / 2);
      await expect(chart.getByText('tillmann · Nightly import').first()).toBeVisible();
      await t.shot('growth-tooltip');

      // The mark of @25 is at the x of the tooltip; its height is the value, so look for it from the top down.
      const detail = frame.locator('.detail h2');
      for (let y = box.y + 12; (await detail.count()) === 0 && y < box.y + box.height - 70; y += 3) {
        await page.mouse.click(x, y);
      }
      await expect(detail).toHaveText(/^@25 · /);
    },
  );

  await t.step('a snapshot: its actions, Show catalog at the snapshot pins the tree', async () => {
    await tableSelect.selectOption({ label: 'shop.customers' });
    await frame.locator('button.pick', { hasText: /^@17$/ }).click();
    await expect(frame.locator('.detail h2')).toHaveText(/^@17 · /);
    await frame.getByRole('button', { name: 'Show catalog at @17', exact: true }).click();
    await expect.poll(status).toBe(`${LAKE} · DuckLake 1.1 · @17 (pinned)`);
    await showPanel(page, LAKE_TAB);
    await t.shot('growth-snapshot');
  });

  await t.step('Open as Markdown: the summary and the snapshots of the table and value', async () => {
    await mode('Data size').click();
    const text = await openAsMarkdown(page, frame, LAKE_TAB);
    expect(text.split('\n')[0]).toBe(`# Growth of ${LAKE}`);
    expect(text).toMatch(/\| Largest increase \| \+1\.5 KB at @17 /);
    expect(text).toMatch(/\| @56 \| .* \| 2\.9 KB \| 0 \| no \|/);
  });

  await t.step('a table: the report opens with the table chosen, in a panel of its own', async () => {
    await open(treeRow(page, 'events'), EVENTS_TAB);
    await expect(tableSelect).toHaveValue(/^k:\d+$/);
    const cards = await cardValues(frame);
    expect([cards.Now, cards['Largest increase'], cards['Largest decrease']]).toEqual(['52', '+40', 'none']);
    await expectDrawnCharts(frame, 1);
    await t.shot('growth-events');
    await expect(panelTab(page, LAKE_TAB)).toHaveCount(1);
  });

  for (const { name, bodyClass } of THEMES) {
    await t.step(
      `the theme ${name}: both panels are drawn again and the policy of the page holds`,
      async () => {
        await runCommand(page, 'Preferences: Color Theme');
        await pick(page, name);
        for (const tab of [LAKE_TAB, EVENTS_TAB]) {
          await showPanel(page, tab);
          await expect(frame.locator('body')).toHaveClass(bodyClass);
          await expectDrawnCharts(frame, 1);
          const slug = name
            .toLowerCase()
            .replace(/[^a-z]+/g, '-')
            .replace(/-$/, '');
          await t.shot(`theme-${slug}-${tab.startsWith('Growth of') ? 'table' : 'lake'}`);
        }
      },
    );
  }

  await t.step('no content security policy message appeared in the console', async () => {
    expect(violations).toEqual([]);
  });
}
