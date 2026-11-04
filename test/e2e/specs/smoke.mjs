import {
  FIXTURES,
  MACHINE_SETTINGS,
  activityBar,
  activityBarTab,
  around,
  eventually,
  expandNode,
  expect,
  imageSha256,
  input,
  maskImageOf,
  notificationTexts,
  openExtensionDetails,
  openView,
  openWorkbench,
  outline,
  outputChannels,
  pick,
  runCommand,
  setColorTheme,
  sidebar,
  treeRow,
  waitForNotification,
} from '../lib/index.mjs';

export const title = 'Smoke: workbench, Activity Bar icon, details page, SQLite connection';

const EXTENSION_ID = 'teitelberg.aantje';

export default async function smoke(t) {
  const { page } = t;
  // What the VSIX put into the container: the manifest and the files that the browser must show.
  const extension = await t.server.installedExtension(EXTENSION_ID);

  await t.step('the workbench loads and the extension is active once its view is open', async () => {
    await openWorkbench(page, { url: t.url });
    // The extension starts on demand: opening its view activates it. Its output channel exists only while it
    // runs, which makes it the proof of the activation.
    await openView(page, 'aantje');
    await expect(sidebar(page)).toContainText('No DuckLake connection yet.');
    await eventually(async () => expect(await outputChannels(page)).toContain('aantje'));
    const failures = (await notificationTexts(page)).filter((text) => /aantje|activat/i.test(text));
    expect(failures, 'no notification about a failed activation').toEqual([]);
    await t.shot('aantje-view-empty');
  });

  await t.step('the aantje icon is in the Activity Bar in the light and in the dark theme', async () => {
    // Not selected, so that the icon is shown in its plain state.
    await openView(page, 'Explorer');
    const tab = activityBarTab(page, 'aantje');
    await expect(tab).toBeVisible();

    // VS Code draws the icon as a mask: what the browser loads for it is the SVG of the package, and nothing
    // else makes the tab show the duck.
    const mask = await maskImageOf(tab.locator('a.action-label'));
    expect(mask.status, `the icon ${mask.url} is served`).toBe(200);
    const [container] = extension.manifest.contributes.viewsContainers.activitybar;
    expect(mask.text).toBe(await t.server.readFile(`${extension.dir}/${container.icon}`));

    const crop = () => around(page, activityBar(page), { through: tab, margin: 6 });
    await t.shot('activity-bar-light', await crop());
    await setColorTheme(page, { name: 'Dark 2026', kind: 'dark' });
    await t.shot('activity-bar-dark', await crop());
  });

  await t.step(
    'the details page of the installed extension shows name, publisher, icon and README',
    async () => {
      const details = await openExtensionDetails(page, EXTENSION_ID);
      await expect(details.name).toHaveText('aantje');
      await expect(details.publisher).toHaveText('teitelberg');
      await expect(details.editor).toContainText(extension.manifest.version);

      await expect(details.icon, 'the icon of the header is loaded').not.toHaveJSProperty('naturalWidth', 0);
      expect(await imageSha256(details.icon), 'the header shows the icon of the package').toBe(
        await t.server.sha256(`${extension.dir}/${extension.manifest.icon}`),
      );

      await expect(details.readme.getByRole('heading', { name: 'Quick start' })).toBeVisible();
      // VS Code removes the address of an image that it cannot resolve; vsce makes the images of the README absolute URLs.
      const unresolved = await details.readme.locator('img:not([src])').count();
      if (unresolved > 0) {
        t.warn(
          `${unresolved} image(s) of the README have no address, so the page has an empty space above the title`,
        );
      }
      await t.shot('extension-details-dark');

      await setColorTheme(page, { name: 'Light 2026', kind: 'light' });
      await t.shot('extension-details-light');
    },
  );

  await t.step(
    'Add Connection saves a SQLite catalog, and the tree shows its schemas, tables and columns',
    async () => {
      const path = `${FIXTURES}/ducklake.sqlite`;
      await openView(page, 'aantje');
      await runCommand(page, 'aantje: Add Connection...');
      await pick(page, 'SQLite', { title: 'Add Connection: where is the DuckLake metadata stored?' });
      await input(page, 'Fixture lake', { title: 'Add Connection (1/3)' });
      await input(page, path, { title: 'Add Connection (2/3)' });
      // The last question: the sessions of the SQL editor. The default is writable.
      await t.shot('wizard-read-only-question');
      await pick(page, 'No', { title: 'Add Connection (3/3): Open SQL editor sessions read-only?' });

      const message = await waitForNotification(page, /^Saved connection/);
      expect(message).toContain('latest snapshot 13');
      await t.shot('connection-saved');
      await expect.poll(() => outline(page)).toEqual(['Fixture lake : sqlite']);

      // Machine scope: code-server keeps the setting in the settings of the machine, next to the defaults of the image.
      const settings = await t.server.readJson(MACHINE_SETTINGS);
      expect(settings['aantje.connections']).toEqual([
        { id: 'fixture-lake', name: 'Fixture lake', kind: 'sqlite', path },
      ]);

      // The first expansion connects. Every level is read when it is expanded.
      await expandNode(page, 'Fixture lake');
      await expandNode(page, 'sales');
      await expandNode(page, 'Tables', { level: 3 });
      await expandNode(page, 'orders');
      await expandNode(page, 'Columns');
      await expandNode(page, 'customer');
      await expect(treeRow(page, 'tags')).toBeVisible();

      await expect
        .poll(() => outline(page))
        .toEqual([
          'Fixture lake : sqlite · DuckLake 1.1 · @13',
          '  main',
          '  sales',
          '    Tables',
          '      orders',
          '        Statistics',
          '        History',
          '        Columns',
          '          id : int32 NOT NULL',
          '          customer : struct',
          '            name : varchar',
          '            tags : list',
          '          attrs : map',
          '          amount : decimal(10,2)',
          '          created : timestamp',
          '    Views',
          '    Macros',
          '  Snapshots',
        ]);
      await t.shot('tree-expanded');
    },
  );
}
