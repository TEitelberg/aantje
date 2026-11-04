import { aantjeStatusText } from '../lib/tree-features-helpers.mjs';
import {
  FIXTURES,
  MACHINE_SETTINGS,
  activeTab,
  answerDialog,
  cancelPrompt,
  chooseFromContextMenu,
  chooseFromSubmenu,
  collapseNode,
  contextMenuItems,
  dismissNotifications,
  editorText,
  expandNode,
  expect,
  hoverText,
  notificationTexts,
  openView,
  openWorkbench,
  outline,
  pick,
  quickInput,
  readClipboard,
  readTree,
  runCommand,
  scrollToRow,
  setEditorText,
  showOutputChannel,
  sidebar,
  statusBarItems,
  submenuItems,
  treeRow,
  waitForNotification,
  writeClipboard,
} from '../lib/index.mjs';

export const title =
  'Helpers: the functions of test/e2e/lib and the control of the server, against the real workbench';

// Not a scenario of the product: each step uses a group of helpers on something that the product shows, so that a
// broken helper (or a VS Code that changed its markup) fails here and not in the spec of somebody else. It is also the
// shortest example of how the helpers are used.
export default async function helpers(t) {
  const { page } = t;
  const path = `${FIXTURES}/ducklake.sqlite`;
  const connection = { id: 'fixture-lake', name: 'Fixture lake', kind: 'sqlite', path };

  await t.step('a spec can set up the settings of the server before it opens the workbench', async () => {
    const settings = await t.server.readJson(MACHINE_SETTINGS);
    await t.server.writeFile(
      MACHINE_SETTINGS,
      JSON.stringify({ ...settings, 'aantje.connections': [connection] }),
    );

    await openWorkbench(page, { url: t.url });
    await openView(page, 'aantje');
    await expect.poll(() => outline(page)).toEqual(['Fixture lake : sqlite']);
  });

  await t.step('runCommand, quickInput, cancelPrompt and the notifications', async () => {
    await runCommand(page, 'aantje: Add Connection...');
    const q = quickInput(page);
    await expect(q.title).toHaveText('Add Connection: where is the DuckLake metadata stored?');
    expect((await q.entries())[1]).toMatchObject({ label: 'SQLite', detail: '' });
    await cancelPrompt(page);

    await runCommand(page, 'aantje: Search Catalog...');
    await waitForNotification(page, /^Connect to a catalog first/);
    await dismissNotifications(page);
    expect(await notificationTexts(page)).toEqual([]);
  });

  await t.step(
    'the tree: expandNode, collapseNode, readTree, outline, tooltip, context menu, clipboard',
    async () => {
      await expandNode(page, 'Fixture lake');
      await expandNode(page, 'sales');
      await expandNode(page, 'Tables', { level: 3 });
      await expandNode(page, 'orders');
      await expandNode(page, 'Columns');
      await expect(treeRow(page, 'customer')).toBeVisible();

      const rows = await readTree(page);
      expect(rows.find((row) => row.label === 'orders')).toEqual({
        label: 'orders',
        description: '',
        level: 4,
        expanded: true,
      });

      expect(await hoverText(page, treeRow(page, 'orders'))).toContain('sales.orders');
      expect(await contextMenuItems(page, treeRow(page, 'orders'))).toContain('Copy DDL');
      await writeClipboard(page, '');
      await chooseFromContextMenu(page, treeRow(page, 'orders'), 'Copy Qualified Name');
      await expect.poll(() => readClipboard(page)).toBe('"sales"."orders"');
      await chooseFromContextMenu(page, treeRow(page, 'orders'), 'Copy DDL');
      await expect.poll(() => readClipboard(page)).toMatch(/^CREATE TABLE "sales"\."orders" \(/);

      await collapseNode(page, 'orders');
      await expect.poll(() => outline(page)).toContain('      orders');
    },
  );

  await t.step(
    'submenus and editors: submenuItems, chooseFromSubmenu, scrollToRow, setEditorText, editorText, activeTab',
    async () => {
      const orders = treeRow(page, 'orders');
      expect(await submenuItems(page, orders, 'Script as')).toContain('Script as SELECT');

      await chooseFromSubmenu(page, orders, 'Script as', 'Script as SELECT');
      await expect(activeTab(page)).toContainText('Untitled-1');
      expect(await editorText(page)).toBe(
        'SELECT\n  "id",\n  "customer",\n  "attrs",\n  "amount",\n  "created"\nFROM "sales"."orders"\nLIMIT 1000;',
      );
      // Brackets and quotes arrive as they are: the text is pasted, not typed.
      const pasted = 'SELECT (1, \'a\') AS "t";\nSELECT 2;';
      await setEditorText(page, pasted);
      expect(await editorText(page)).toBe(pasted);
      // The explorer is shown again, and a row of its list can be scrolled to.
      await openView(page, 'aantje');
      await expect(await scrollToRow(page, 'Snapshots')).toBeVisible();
    },
  );

  await t.step('pick answers the picker of a command, and the status bar shows the snapshot', async () => {
    const q = quickInput(page);
    await runCommand(page, 'aantje: Show Catalog at Snapshot...');
    expect((await q.entries())[0].label).toBe('Latest');
    await pick(page, '@5');
    await expect.poll(() => aantjeStatusText(page)).toBe('Fixture lake · DuckLake 1.1 · @5 (pinned)');

    await runCommand(page, 'aantje: Show Catalog at Snapshot...');
    await pick(page, 'Latest');
    const items = await statusBarItems(page);
    expect(items.map((item) => item.text)).toContain('Fixture lake · DuckLake 1.1 · latest (@13)');
  });

  await t.step('showOutputChannel shows the log, which the server has as a file as well', async () => {
    const output = await showOutputChannel(page, 'aantje');
    await expect(output).toContainText('Connected to "Fixture lake"');
    expect(await t.server.readLog('teitelberg.aantje/aantje.log')).toContain('Connected to "Fixture lake"');
  });

  await t.step(
    'restart keeps the data: the connection is there after the workbench is opened again',
    async () => {
      await t.server.restart();
      await openWorkbench(page, { url: t.url });
      await openView(page, 'aantje');
      await expect.poll(() => outline(page)).toEqual(['Fixture lake : sqlite']);
    },
  );

  await t.step('answerDialog answers the confirmation of Remove Connection', async () => {
    const remove = () => chooseFromContextMenu(page, treeRow(page, 'Fixture lake'), 'Remove Connection');
    const message = 'Remove the connection "Fixture lake"?';

    await remove();
    await answerDialog(page, 'Cancel', { message });
    await expect.poll(() => outline(page)).toEqual(['Fixture lake : sqlite']);

    await remove();
    await answerDialog(page, 'Remove', { message });
    await expect(sidebar(page)).toContainText('No DuckLake connection yet.');
  });

  await t.step('the server control: exec, writeFile, readFile, sha256 and reset', async () => {
    const text = `it's "quoted" \\ and\nmultiline\n`;
    await t.server.writeFile('/tmp/e2e-helpers/text.txt', text);
    expect(await t.server.readFile('/tmp/e2e-helpers/text.txt')).toBe(text);
    expect((await t.server.exec('id -un && echo failing >&2; exit 3')).code).toBe(3);
    expect(await t.server.sha256('/tmp/e2e-helpers/text.txt')).toMatch(/^[0-9a-f]{64}$/);

    await t.server.reset();
    expect(
      (await t.server.readJson(MACHINE_SETTINGS))['aantje.connections'],
      'reset empties the user data',
    ).toBeUndefined();
    expect((await t.server.installedExtension('teitelberg.aantje')).manifest.name).toBe('aantje');
  });
}
