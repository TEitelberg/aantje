import {
  MACHINE_SETTINGS,
  USER_SETTINGS,
  cancelPrompt,
  expandNode,
  expect,
  input,
  openView,
  openWorkbench,
  outline,
  pick,
  quickInput,
  runCommand,
  showOutputChannel,
  statusBarItem,
  treeRow,
  waitForNotification,
} from '../lib/index.mjs';
import {
  addPostgresConnection,
  allAantjeLogs,
  clickInlineAction,
  expectPasswordPrompt,
  filesContaining,
  postgresFromEnvironment,
  recordNotifications,
} from '../lib/postgres-secrets-support.mjs';

export const title =
  'PostgreSQL: the wizard, the password in the secret storage, restarts, provisioned profiles and wrong passwords';

const SETTING = 'aantje.connections';
const ASK = 'The server asks for a password. It is kept in the secret storage, not in the settings.';
const REJECTED =
  'The stored password was rejected. Enter the current password; it is kept in the secret storage.';

// Needs PostgreSQL: test/e2e/run.ps1 starts it for a spec that reads E2E_POSTGRES_* and hands over the data.
export default async function postgresSecrets(t) {
  const { page, server } = t;
  const pg = postgresFromEnvironment();
  const q = quickInput(page);
  const seenNotifications = await recordNotifications(page);
  const wrong = ['wrong-password-one', 'wrong-password-two', 'wrong-password-three'];
  const endpoint = `${pg.host}:${pg.port}`;
  const rejectedByServer = `Authentication failed on ${endpoint}: password authentication failed for user "${pg.user}".`;
  const profile = (name, extra = {}) => ({
    name,
    kind: 'postgres',
    host: pg.host,
    database: pg.database,
    user: pg.user,
    // The fixture server has no TLS; a remote host gets TLS unless the entry says otherwise.
    ssl: false,
    ...extra,
  });
  const machineConnections = async () => (await server.readJson(MACHINE_SETTINGS))[SETTING];
  const reopen = async () => {
    await openWorkbench(page, { url: t.url });
    await openView(page, 'aantje');
  };
  // The tree right after a successful connection: the two schemas of the fixture catalog.
  const connectionRows = async () => (await outline(page)).filter((line) => !line.startsWith(' '));
  const catalog = (name) => [`${name} : postgres · DuckLake 1.1 · @13`, '  main', '  sales', '  Snapshots'];

  await t.step('Add Connection with a password saves the profile and shows the catalog', async () => {
    await reopen();
    await runCommand(page, 'aantje: Add Connection...');
    await addPostgresConnection(page, { name: 'Lake PG', ...pg, tls: 'No' });

    const message = await waitForNotification(page, /^Saved connection/);
    expect(message).toBe('Saved connection "Lake PG". DuckLake spec version 1.1, latest snapshot 13.');
    await t.shot('connection-saved');
    await expect.poll(() => outline(page)).toEqual(['Lake PG : postgres']);

    await expandNode(page, 'Lake PG');
    await expandNode(page, 'sales');
    await expandNode(page, 'Tables', { level: 3 });
    await expandNode(page, 'orders');
    await expandNode(page, 'Columns');
    await expect(treeRow(page, 'customer')).toBeVisible();
    await expandNode(page, 'customer');
    await expect(treeRow(page, 'tags')).toBeVisible();
    await expect(q.widget, 'the stored password is used without a question').toBeHidden();
    await expect
      .poll(() => outline(page))
      .toEqual([
        'Lake PG : postgres · DuckLake 1.1 · @13',
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
    await expect(statusBarItem(page, 'Lake PG')).toContainText('Lake PG · DuckLake 1.1 · latest (@13)');
    await t.shot('tree-expanded');
  });

  await t.step('the wizard writes the profile without the password to the machine settings', async () => {
    const machine = await server.readJson(MACHINE_SETTINGS);
    expect(machine[SETTING]).toEqual([
      {
        id: 'lake-pg',
        name: 'Lake PG',
        kind: 'postgres',
        host: pg.host,
        port: pg.port,
        database: pg.database,
        user: pg.user,
        ssl: false,
      },
    ]);
    const { code } = await server.exec(`test -f ${USER_SETTINGS}`);
    if (code === 0) {
      expect((await server.readJson(USER_SETTINGS))[SETTING], 'not in the user settings').toBeUndefined();
    }
    expect(await server.readFile(MACHINE_SETTINGS)).not.toContain(pg.password);
  });

  await t.step(
    'code-server keeps the secret in the browser, not on the server, and not in clear text',
    async () => {
      // The secret storage of the web workbench is the local storage of the browser for this origin.
      const stored = await page.evaluate(() => globalThis.localStorage.getItem('secrets.provider'));
      expect(stored, 'the browser holds the secrets').not.toBeNull();
      expect(stored).not.toContain(pg.password);
      expect(await filesContaining(server, pg.password), 'no file on the server holds the password').toEqual(
        [],
      );
    },
  );

  await t.step(
    'after a restart of code-server the connection works without a password question',
    async () => {
      await server.restart();
      await reopen();
      await expect.poll(() => outline(page)).toEqual(['Lake PG : postgres']);
      await expandNode(page, 'Lake PG');
      await expect.poll(() => outline(page)).toEqual(catalog('Lake PG'));
      await expect(q.widget, 'no password question').toBeHidden();
      await t.shot('restart-no-question');
      expect(await machineConnections()).toHaveLength(1);
    },
  );

  await t.step('a browser without the stored secret is asked for the password once', async () => {
    // Another browser, another profile or cleared site data: same server, same profile, empty secret storage.
    const fresh = await page
      .context()
      .browser()
      .newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const other = await fresh.newPage();
      other.setDefaultTimeout(20_000);
      await openWorkbench(other, { url: t.url });
      await openView(other, 'aantje');
      await expandNode(other, 'Lake PG');
      expect(await expectPasswordPrompt(other, 'Lake PG')).toBe(ASK);
      await input(other, pg.password, { title: 'Password for "Lake PG"' });
      await expect.poll(() => outline(other)).toEqual(catalog('Lake PG'));
      await expect(quickInput(other).widget).toBeHidden();
    } finally {
      await fresh.close();
    }
  });

  await t.step('a provisioned profile without a password asks once, then keeps the password', async () => {
    const provisioned = profile('Provisioned lake');
    const machine = await server.readJson(MACHINE_SETTINGS);
    await server.writeFile(
      MACHINE_SETTINGS,
      JSON.stringify({ ...machine, [SETTING]: [...machine[SETTING], provisioned] }, undefined, 4),
    );
    await reopen();
    await expect.poll(() => outline(page)).toEqual(['Lake PG : postgres', 'Provisioned lake : postgres']);

    await expandNode(page, 'Provisioned lake');
    expect(await expectPasswordPrompt(page, 'Provisioned lake')).toBe(ASK);
    await t.shot('password-prompt');
    await input(page, pg.password, { title: 'Password for "Provisioned lake"' });
    await expect.poll(() => outline(page)).toEqual(['Lake PG : postgres', ...catalog('Provisioned lake')]);
    await expect(q.widget, 'asked once').toBeHidden();
    expect(
      (await machineConnections())[1],
      'storing the password leaves the provisioned entry as it was',
    ).toEqual(provisioned);

    await server.restart();
    await reopen();
    await expandNode(page, 'Provisioned lake');
    await expect.poll(() => outline(page)).toContain('  sales');
    await expect(q.widget, 'no question after the restart').toBeHidden();
  });

  await t.step('a stored password that the server rejects is asked for again', async () => {
    await runCommand(page, 'aantje: Add Connection...');
    await addPostgresConnection(page, { name: 'Stale password', ...pg, password: wrong[0] });
    const failure = await waitForNotification(page, /^Connection test failed/);
    expect(failure).toBe(
      `Connection test failed: Authentication failed on ${endpoint}: password authentication failed for user "${pg.user}".`,
    );
    await t.shot('wizard-test-failed');
    await pick(page, 'Save anyway', { title: 'The connection test failed' });
    await expect
      .poll(connectionRows)
      .toEqual([
        'Lake PG : postgres',
        'Provisioned lake : postgres · DuckLake 1.1 · @13',
        'Stale password : postgres',
      ]);

    await expandNode(page, 'Stale password');
    expect(await expectPasswordPrompt(page, 'Stale password')).toBe(REJECTED);
    await t.shot('rejected-prompt');

    // A wrong answer shows the error and keeps the question alive for the next try.
    await input(page, wrong[1], { title: 'Password for "Stale password"' });
    await expect.poll(connectionRows).toContain('Stale password : postgres · connection failed');
    await expect(treeRow(page, rejectedByServer)).toBeVisible();
    await t.shot('wrong-answer');
    await clickInlineAction(page, treeRow(page, 'Stale password'), 'Connect');
    expect(await expectPasswordPrompt(page, 'Stale password'), 'the stale password is still stored').toBe(
      REJECTED,
    );
    await input(page, pg.password, { title: 'Password for "Stale password"' });
    await expect.poll(connectionRows).toContain('Stale password : postgres · DuckLake 1.1 · @13');
    await expect(q.widget, 'asked once per attempt').toBeHidden();

    await server.restart();
    await reopen();
    await expandNode(page, 'Stale password');
    await expect.poll(connectionRows).toContain('Stale password : postgres · DuckLake 1.1 · @13');
    await expect(q.widget, 'the right password replaced the stale one').toBeHidden();
  });

  await t.step('a wrong password that is typed is not stored', async () => {
    const machine = await server.readJson(MACHINE_SETTINGS);
    await server.writeFile(
      MACHINE_SETTINGS,
      JSON.stringify({ ...machine, [SETTING]: [...machine[SETTING], profile('Never stored')] }, undefined, 4),
    );
    await reopen();
    await expandNode(page, 'Never stored');
    expect(await expectPasswordPrompt(page, 'Never stored')).toBe(ASK);
    await input(page, wrong[2], { title: 'Password for "Never stored"' });
    await expect(treeRow(page, rejectedByServer)).toBeVisible();

    // Nothing was stored: the next attempt asks the plain question again, not "the stored password was rejected".
    await clickInlineAction(page, treeRow(page, 'Never stored'), 'Connect');
    expect(await expectPasswordPrompt(page, 'Never stored')).toBe(ASK);
    await cancelPrompt(page);
    await expect(
      treeRow(page, `${endpoint} asks for a password, but none is stored for user "${pg.user}".`),
    ).toBeVisible();
    await t.shot('cancelled');

    await clickInlineAction(page, treeRow(page, 'Never stored'), 'Connect');
    expect(await expectPasswordPrompt(page, 'Never stored')).toBe(ASK);
    await input(page, pg.password, { title: 'Password for "Never stored"' });
    await expect.poll(connectionRows).toContain('Never stored : postgres · DuckLake 1.1 · @13');
  });

  await t.step('no password appears in a notification, a log, a settings file or the page', async () => {
    const passwords = [pg.password, ...wrong];
    const failureToast = `Connection test failed: Authentication failed on ${endpoint}: password authentication failed for user "${pg.user}".`;
    expect(seenNotifications, 'the toasts of the failures were seen').toContain(failureToast);
    for (const password of passwords) {
      expect(seenNotifications.filter((text) => text.includes(password))).toEqual([]);
      expect(await filesContaining(server, password), 'no file on the server').toEqual([]);
      expect(await page.locator('body').innerText()).not.toContain(password);
    }

    const output = await showOutputChannel(page, 'aantje');
    await expect(output).toContainText('Connected to "Never stored"');
    const shown = await output.innerText();
    const log = await allAantjeLogs(server);
    for (const name of ['Stale password', 'Never stored']) {
      expect(log, 'the failures are logged').toContain(`Cannot connect to "${name}".`);
    }
    // The log masks every password that it knows with "***": no mask means no password ever reached a log call.
    expect(log).not.toContain('***');
    for (const password of passwords) {
      expect(shown).not.toContain(password);
      expect(log).not.toContain(password);
    }
    await t.shot('output-channel');
  });
}
