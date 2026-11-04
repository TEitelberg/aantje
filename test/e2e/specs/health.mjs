import {
  MACHINE_SETTINGS,
  PROJECT,
  activeTab,
  chooseFromContextMenu,
  chooseFromSubmenu,
  collapseNode,
  dismissNotifications,
  editorText,
  expandNode,
  expect,
  input,
  notificationButtons,
  openView,
  openWorkbench,
  outline,
  pick,
  pressNotificationButton,
  quickInput,
  runCommand,
  treeRow,
  waitForNotification,
} from '../lib/index.mjs';
import {
  installHistoryFixture,
  runTool,
  s3FromEnvironment,
  s3Request,
  webview,
} from '../lib/data-features-support.mjs';
import { cardValues, panelTab, showPanel, watchCspViolations } from '../lib/panels.mjs';
import { queryStatusText } from '../lib/sql-editor-support.mjs';
import { aantjeStatusText, waitForConnectedMenu } from '../lib/tree-features-helpers.mjs';

export const title =
  'Health check: a healthy lake, a lake that lost a file, the deep check, Check Table Health and the button in the error message';

const LAKE = 'History';
const BROKEN = 'History broken';
const BROKEN_DIR = `${PROJECT}/history-broken`;
const NODE = '/usr/lib/code-server/lib/node';
const S3_LAKE = 'S3 lake';
const BUCKET = 'e2e-lake';
const S3_CATALOG = '/home/coder/project/s3/catalog.sqlite';

// Prints the files that the newest snapshot of shop.log needs, as the catalog names them (relative to the table directory).
const CURRENT_FILES = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const rows = db.prepare(
  "SELECT f.path FROM ducklake_data_file f JOIN ducklake_table t ON t.table_id = f.table_id AND t.end_snapshot IS NULL WHERE t.table_name = ? AND f.end_snapshot IS NULL ORDER BY f.data_file_id",
).all(process.argv[3]);
console.log(JSON.stringify(rows.map((row) => row.path)));
`;

// Needs an S3 server: test/e2e/run.ps1 starts it for a spec that reads E2E_S3_* (s3FromEnvironment).
export default async function health(t) {
  const { page, server } = t;
  const s3 = s3FromEnvironment();
  const q = quickInput(page);
  const frame = webview(page);
  const violations = watchCspViolations(page);
  const lake = (name = LAKE) => treeRow(page, name);
  let lostFile;

  /** Opens a panel of the health check from the Reports submenu and waits until its run has ended. */
  const check = async (row, label, tab) => {
    await chooseFromSubmenu(page, row, 'Reports', label);
    await expect(panelTab(page, tab)).toHaveCount(1);
    await showPanel(page, tab);
    await expect(frame.locator('h1')).toHaveText('Health check', { timeout: 60_000 });
    await expect(frame.getByRole('button', { name: /^Run again/ })).toBeVisible({ timeout: 90_000 });
  };
  const verdict = () => frame.locator('.verdict').textContent();
  const groups = () =>
    frame
      .locator('ul.groups li')
      .evaluateAll((items) => items.map((item) => item.textContent.replace(/\s+/g, ' ').trim()));

  await t.step('prepare: the history catalog, a copy of it that lost a file, and a lake on S3', async () => {
    const catalog = await installHistoryFixture(server);
    await runTool(server, ['prefetch'], { timeoutSeconds: 300 });
    // The copy: the same catalog and files in another folder, whose data path is its own.
    const copy = await server.exec(
      `rm -rf ${BROKEN_DIR} && mkdir -p ${BROKEN_DIR} && cp -r ${PROJECT}/history/sqlite-files ${PROJECT}/history/history.sqlite ${BROKEN_DIR}/ && chmod -R u+w ${BROKEN_DIR}`,
    );
    expect(copy.code, copy.stderr).toBe(0);
    await runTool(server, [
      'sqlite',
      `${BROKEN_DIR}/history.sqlite`,
      `UPDATE ducklake_metadata SET value = '${BROKEN_DIR}/sqlite-files/' WHERE key = 'data_path'`,
    ]);
    await server.writeFile('/tmp/health-current-files.mjs', CURRENT_FILES);
    const listed = await server.exec(
      `${NODE} --no-warnings /tmp/health-current-files.mjs ${BROKEN_DIR}/history.sqlite log`,
    );
    expect(listed.code, listed.stderr).toBe(0);
    const files = JSON.parse(listed.stdout);
    // The merged file of the compaction and the one of snapshot 56: the newest snapshot needs both.
    expect(files).toHaveLength(2);
    lostFile = files.at(-1);
    const removed = await server.exec(`rm ${BROKEN_DIR}/sqlite-files/shop/log/${lostFile}`);
    expect(removed.code, removed.stderr).toBe(0);
    expect((await server.exec(`ls ${BROKEN_DIR}/sqlite-files/shop/log`)).stdout).not.toContain(lostFile);

    // A DuckLake whose Parquet files are in a bucket of the S3 server, written the way a data engineer does it.
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

    const settings = await server.readJson(MACHINE_SETTINGS);
    await server.writeFile(
      MACHINE_SETTINGS,
      JSON.stringify({
        ...settings,
        'aantje.connections': [
          { id: 'history', name: LAKE, kind: 'sqlite', path: catalog },
          { id: 'history-broken', name: BROKEN, kind: 'sqlite', path: `${BROKEN_DIR}/history.sqlite` },
          { id: 's3-lake', name: S3_LAKE, kind: 'sqlite', path: S3_CATALOG },
        ],
        'aantje.s3.endpoint': s3.endpoint,
        'aantje.s3.region': 'us-east-1',
        'aantje.s3.urlStyle': 'path',
      }),
    );
    await openWorkbench(page, { url: t.url });
    await openView(page, 'aantje');
    await runCommand(page, 'View: Toggle Secondary Side Bar Visibility');
    await lake().click();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => aantjeStatusText(page)).toBe(`${LAKE} · DuckLake 1.1 · latest (@56)`);
    await waitForConnectedMenu(page, lake());
  });

  await t.step('a healthy lake: no errors and no warnings, and what was checked', async () => {
    const tab = `Health · ${LAKE}`;
    await check(lake(), 'Check Health', tab);
    await expect(frame.locator('.subtitle')).toHaveText(`Lakehouse · ${LAKE} · checked snapshot @56`);
    expect(await verdict()).toBe('No problems found.');
    const cards = await cardValues(frame);
    expect([cards.Errors, cards.Warnings]).toEqual(['0', '0']);
    expect(cards['Checked snapshot']).toBe('@56');
    expect(await groups()).toEqual([
      'Catalog✔ Done',
      'Connection✔ Done',
      'Storage✔ Done',
      'Deep– Skipped: Not part of the quick check.',
    ]);
    // A healthy result says what it does not cover.
    await expect(frame.locator('.coverage')).toContainText('What was not checked');
    await expect(frame.locator('.coverage')).toContainText('Deep: Not part of the quick check.');
    // The infos are no problems, and they stay listed: the files of the compaction wait for the cleanup.
    await expect(frame.locator('.health-finding.error, .health-finding.warning')).toHaveCount(0);
    await expect(frame.locator('.health-finding.info')).toHaveCount(2);
    await t.shot('health-healthy');
  });

  await t.step('the deep check reads the Parquet footers and finds the healthy lake healthy', async () => {
    await frame.getByRole('button', { name: /^Deep check/ }).click();
    await expect(frame.getByLabel('Number of files to open')).toHaveValue('200');
    await frame.getByRole('button', { name: /^Run again/ }).click();
    await expect.poll(async () => (await groups())[3], { timeout: 90_000 }).toBe('Deep✔ Done');
    await expect(frame.getByRole('button', { name: /^Run again/ })).toBeEnabled();
    expect(await verdict()).toBe('No problems found.');
    expect((await cardValues(frame)).Errors).toBe('0');
    await t.shot('health-deep');
  });

  await t.step('a lake that lost a file: storage.file-missing is an error with its actions', async () => {
    await collapseNode(page, LAKE);
    await lake(BROKEN).click();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => aantjeStatusText(page)).toBe(`${BROKEN} · DuckLake 1.1 · latest (@56)`);
    await waitForConnectedMenu(page, lake(BROKEN));
    await check(lake(BROKEN), 'Check Health', `Health · ${BROKEN}`);
    expect(await verdict()).toMatch(/^Found 1 error/);
    expect((await cardValues(frame)).Errors).toBe('1');
    expect(await groups()).toContain('Storage✔ Done');

    const errors = frame.locator('.health-finding.error');
    await expect(errors).toHaveCount(1);
    // The sign and the word say the severity, not the colour alone.
    await expect(errors.locator('summary .sev')).toHaveText('✖ Error');
    await errors.locator('summary').click();
    await expect(errors.locator('dl')).toContainText('storage.file-missing (Storage)');
    await expect(errors.locator('dl')).toContainText(lostFile);
    await expect(errors.locator('dl')).toContainText('shop.log');
    for (const label of ['Open SQL to inspect', 'Show table in tree', 'Show Statistics']) {
      await expect(errors.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
    }
    await t.shot('health-file-missing');

    // Open SQL to inspect: an untitled SQL document of the connection that holds the SQL of the card. It is not run.
    const shown = (await errors.locator('pre code').textContent()).trim();
    await errors.getByRole('button', { name: /^Open SQL to inspect/ }).click();
    await expect(activeTab(page)).toContainText(/Untitled-\d+/);
    expect((await editorText(page)).trim()).toBe(shown);
    await expect.poll(() => queryStatusText(page)).toBe(`${BROKEN} · read/write`);
    await t.shot('health-open-sql');
  });

  await t.step('Check Table Health from the table menu checks one table', async () => {
    await expandNode(page, 'shop');
    await expandNode(page, 'Tables', { level: 3 });
    await dismissNotifications(page);
    await check(treeRow(page, 'log'), 'Check Table Health', `Health · ${BROKEN} · shop.log`);
    await expect(frame.locator('.subtitle')).toHaveText(`shop.log · ${BROKEN} · checked snapshot @56`);
    expect(await verdict()).toMatch(/^Found 1 error/);
    await expect(frame.locator('.health-finding.error')).toHaveCount(1);
    await t.shot('health-table-log');

    // Another table of the same lake is fine.
    await check(treeRow(page, 'events'), 'Check Table Health', `Health · ${BROKEN} · shop.events`);
    expect(await verdict()).toBe('No problems found.');
  });

  await t.step(
    'a missing local file is explained, has the button, and the button opens the table check with storage.file-missing',
    async () => {
      // The check of the table from the step before is closed, so that the panel that the button opens is a new one.
      const tab = `Health · ${BROKEN} · shop.log`;
      await showPanel(page, tab);
      await runCommand(page, 'View: Close Editor');
      await expect(panelTab(page, tab)).toHaveCount(0);
      await dismissNotifications(page);

      await chooseFromContextMenu(page, treeRow(page, 'log'), 'Select Top 1000 Rows');
      const message = await waitForNotification(page, /Cannot read the data of/);
      expect(message).toContain(
        `the catalog lists the data file ${BROKEN_DIR}/sqlite-files/shop/log/${lostFile}`,
      );
      expect(message).toContain('does not exist on this machine (No such file or directory)');
      expect(message).toContain('Likely causes: ');
      expect(message).not.toMatch(/S3|aantje[.]s3/);
      expect(await notificationButtons(page, /Cannot read the data of/)).toEqual(['Check Table Health']);
      await t.shot('health-local-read-failed');

      await pressNotificationButton(page, /Cannot read the data of/, 'Check Table Health');
      await expect(panelTab(page, tab)).toHaveCount(1);
      await showPanel(page, tab);
      await expect(frame.getByRole('button', { name: /^Run again/ })).toBeVisible({ timeout: 90_000 });
      expect(await verdict()).toMatch(/^Found 1 error/);
      const errors = frame.locator('.health-finding.error');
      await expect(errors).toHaveCount(1);
      await errors.locator('summary').click();
      await expect(errors.locator('dl')).toContainText('storage.file-missing (Storage)');
      await expect(errors.locator('dl')).toContainText(lostFile);
      await t.shot('health-local-error-button-panel');
    },
  );

  await t.step(
    'the button in the message of a read that fails with 404 on S3 opens the table check',
    async () => {
      await dismissNotifications(page);
      await collapseNode(page, BROKEN);
      // The keys go to the secret storage with the command, like a user does it.
      await runCommand(page, 'aantje: Set S3 Credentials...');
      await input(page, s3.keyId, { title: 'Set S3 Credentials (1/2)' });
      await expect(q.title).toHaveText('Set S3 Credentials (2/2)');
      await q.input.fill(s3.secretKey);
      await page.keyboard.press('Enter');
      await waitForNotification(page, 'The S3 credentials are stored in the secret storage.');
      await dismissNotifications(page);

      await lake(S3_LAKE).click();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => aantjeStatusText(page)).toMatch(/^S3 lake · DuckLake 1\.1 · latest \(@\d+\)$/);
      await waitForConnectedMenu(page, lake(S3_LAKE));
      await expandNode(page, 'shop');
      await expandNode(page, 'Tables', { level: 3 });

      // The object is removed from the bucket: the catalog still lists it.
      // The file that the catalog names (the bucket may hold files of an earlier run under the same prefix).
      const named = await server.exec(
        `${NODE} --no-warnings /tmp/health-current-files.mjs ${S3_CATALOG} items`,
      );
      expect(named.code, named.stderr).toBe(0);
      const [file] = JSON.parse(named.stdout);
      const key = `ducklake/shop/items/${file}`;
      const listing = await s3Request(
        server,
        s3,
        'GET',
        `/${BUCKET}?list-type=2&prefix=ducklake/shop/items/`,
      );
      expect(listing.body, 'the Parquet file of shop.items is in the bucket').toContain(`<Key>${key}</Key>`);
      expect((await s3Request(server, s3, 'DELETE', `/${BUCKET}/${key}`)).status).toBe(204);
      const after = await s3Request(server, s3, 'GET', `/${BUCKET}?list-type=2&prefix=ducklake/shop/items/`);
      expect(after.body, 'the object is gone from the bucket').not.toContain(key);
      expect(
        (await s3Request(server, s3, 'GET', `/${BUCKET}/${key}`)).status,
        'a request for the key is a 404',
      ).toBe(404);

      await chooseFromContextMenu(page, treeRow(page, 'items'), 'Select Top 1000 Rows');
      const message = await waitForNotification(page, /Cannot read the data of "shop\.items"/);
      expect(message).toContain('HTTP 404');
      expect(message).toContain(key.split('/').at(-1));
      expect(await notificationButtons(page, /Cannot read the data of/)).toEqual(['Check Table Health']);
      await t.shot('health-error-button');

      await pressNotificationButton(page, /Cannot read the data of/, 'Check Table Health');
      const tab = `Health · ${S3_LAKE} · shop.items`;
      await expect(panelTab(page, tab)).toHaveCount(1);
      await showPanel(page, tab);
      // The check starts at once and ends with the finding for the object that the bucket lost.
      await expect(frame.getByRole('button', { name: /^Run again/ })).toBeVisible({ timeout: 90_000 });
      // On a bucket without other files of the table the empty directory is a second error; one with leftovers has none.
      expect(await verdict()).toMatch(/^Found [12] errors?/);
      const errors = frame
        .locator('.health-finding.error')
        .filter({ hasText: 'A data file that the newest snapshot needs is missing' });
      await expect(errors).toHaveCount(1);
      await errors.locator('summary').click();
      await expect(errors.locator('dl')).toContainText('storage.file-missing (Storage)');
      await expect(errors.locator('dl')).toContainText(key);
      await t.shot('health-error-button-panel');
    },
  );

  for (const [name, bodyClass] of [
    ['Dark+', /vscode-dark/],
    ['Light+', /vscode-light/],
    ['Dark High Contrast', /vscode-high-contrast(?!-light)/],
  ]) {
    await t.step(
      `the theme ${name}: the panel of the lost file is readable, with the sign and the word of its severity`,
      async () => {
        await runCommand(page, 'Preferences: Color Theme');
        await pick(page, name);
        await showPanel(page, `Health · ${BROKEN} · shop.log`);
        await expect(frame.locator('body')).toHaveClass(bodyClass);
        await expect(frame.locator('.health-finding.error summary .sev')).toHaveText('✖ Error');
        await t.shot(
          `theme-${name
            .toLowerCase()
            .replace(/[^a-z]+/g, '-')
            .replace(/-$/, '')}-health`,
        );
      },
    );
  }

  await t.step('no content security policy message appeared in the console', async () => {
    expect(violations).toEqual([]);
  });

  await t.step('the tree is as it was: the checks changed nothing', async () => {
    expect(await outline(page)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^S3 lake : sqlite · DuckLake 1\.1 · @\d+$/)]),
    );
  });
}
