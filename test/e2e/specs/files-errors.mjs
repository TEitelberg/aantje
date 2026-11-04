import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import {
  FIXTURES,
  MACHINE_SETTINGS,
  chooseFromContextMenu,
  collapseNode,
  dismissNotifications,
  eventually,
  expandNode,
  expect,
  hoverText,
  input,
  notificationTexts,
  openView,
  openWorkbench,
  pick,
  quickInput,
  readTree,
  runCommand,
  sidebar,
  statusBarItem,
  treeRow,
  waitForNotification,
} from '../lib/index.mjs';
import { installDuckdbApi } from '../lib/duckdb-api.mjs';

export const title =
  'Files and errors: DuckDB and SQLite catalogs in code-server and every way a connection fails';

const LAKES = '/home/coder/lakes';
const NODE = '/usr/lib/code-server/lib/node';
const TOOLS = '/tmp/e2e-files-errors';
const TOOL = `${TOOLS}/lake-tool.mjs`;

const quote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

const READ_ONLY_TITLE =
  'Add Connection (3/3): Open SQL editor sessions read-only? A writable session locks the DuckDB file exclusively, so the explorer cannot read it while the editor has it open.';

const NOT_A_DUCKLAKE =
  'This database is not a DuckLake catalog: the tables "ducklake_metadata" and "ducklake_snapshot" are missing or cannot be read.';

// The catalog that the fixtures hold, as the tree shows it (the same at every snapshot-13 reader).
const FIXTURE_TREE = (root) => [
  root,
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
];

// The connection that works, at its schemas: the folder Snapshots comes after them.
const SCHEMAS = (root) => [root, '  main', '  sales', '  Snapshots'];

const pg = {
  host: process.env.E2E_POSTGRES_HOST,
  port: Number(process.env.E2E_POSTGRES_PORT ?? 5432),
  database: process.env.E2E_POSTGRES_DATABASE,
  user: process.env.E2E_POSTGRES_USER,
  password: process.env.E2E_POSTGRES_PASSWORD,
};

/** The connections of the explorer: three that work, then one for each way a connection can fail. */
const PROFILES = [
  { name: 'Fixture lake', kind: 'sqlite', path: `${FIXTURES}/ducklake.sqlite` },
  { name: 'DuckDB lake', kind: 'duckdb', path: `${LAKES}/ducklake.duckdb` },
  { name: 'Spec 1.0 lake', kind: 'sqlite', path: `${FIXTURES}/ducklake-1.0.sqlite` },
  { name: 'Missing SQLite file', kind: 'sqlite', path: `${LAKES}/missing.sqlite` },
  { name: 'Text as SQLite', kind: 'sqlite', path: `${LAKES}/notes.txt` },
  { name: 'Text as DuckDB', kind: 'duckdb', path: `${LAKES}/notes.txt` },
  { name: 'Empty SQLite file', kind: 'sqlite', path: `${LAKES}/empty.sqlite` },
  { name: 'Empty DuckDB file', kind: 'duckdb', path: `${LAKES}/empty.duckdb` },
  { name: 'Plain SQLite', kind: 'sqlite', path: `${LAKES}/plain.sqlite` },
  { name: 'Plain DuckDB', kind: 'duckdb', path: `${LAKES}/plain.duckdb` },
  { name: 'Future version', kind: 'sqlite', path: `${LAKES}/future.sqlite` },
  { name: 'WAL SQLite', kind: 'sqlite', path: `${LAKES}/wal.sqlite` },
  { name: 'Locked DuckDB', kind: 'duckdb', path: `${LAKES}/locked.duckdb` },
  { name: 'Late DuckDB', kind: 'duckdb', path: `${LAKES}/late.duckdb` },
  { name: 'Slow DuckDB', kind: 'duckdb', path: `${LAKES}/slow.duckdb` },
  {
    name: 'No such host',
    kind: 'postgres',
    host: 'no-such-host.invalid',
    port: 5432,
    database: 'x',
    user: 'x',
  },
  { name: 'Closed port', kind: 'postgres', host: pg.host, port: 1, database: 'x', user: 'x', ssl: false },
].map((profile) => ({ id: profile.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'), ...profile }));

export default async function filesErrors(t) {
  const { page } = t;
  if (!pg.host || !pg.password) {
    throw new Error(
      'E2E_POSTGRES_* is not set: run this spec with test/e2e/run.ps1, which starts the database.',
    );
  }
  const holders = [];
  try {
    await scenario(t, holders);
  } finally {
    // The other applications are processes of the container: they must not outlive the spec.
    await Promise.all(holders.map((holder) => holder.stop().catch(() => undefined)));
    await page.screenshot().catch(() => undefined);
  }
}

async function scenario(t, holders) {
  const { page } = t;

  /** Runs a command in the container; a failure throws with the output. */
  async function sh(command) {
    const { code, stdout, stderr } = await t.server.exec(`NODE_NO_WARNINGS=1 ${command}`);
    if (code !== 0) {
      throw new Error(`${command} failed with ${code}: ${stderr || stdout}`);
    }
    return stdout;
  }
  const tool = (...args) => sh(`${NODE} ${TOOL} ${args.map(quote).join(' ')}`);

  /** Starts another application that keeps a catalog file open (mode: hold-duckdb or hold-wal) until `stop()`. */
  async function startHolder(mode, file) {
    const ready = `${file}.ready`;
    await sh(
      `rm -f ${quote(ready)}; (setsid ${NODE} ${TOOL} ${mode} ${quote(file)} ${quote(ready)} >${quote(`${ready}.log`)} 2>&1 </dev/null &)`,
    );
    await eventually(async () => expect((await t.server.exec(`test -s ${quote(ready)}`)).code).toBe(0), {
      timeout: 30_000,
    });
    const pid = (await t.server.readFile(ready)).trim();
    const holder = {
      async stop() {
        holders.splice(holders.indexOf(holder), 1);
        await t.server.exec(`kill ${pid} 2>/dev/null; true`);
        // The container has no init process, so a finished holder stays a zombie, which `kill -0` still finds.
        const alive = `grep -qs '^State:[[:space:]]*[RSDT]' /proc/${pid}/status`;
        await eventually(async () => expect((await t.server.exec(alive)).code).not.toBe(0), {
          timeout: 30_000,
        });
      },
    };
    holders.push(holder);
    return holder;
  }

  /** The rows of one connection and everything below it, in the format of `outline`. */
  async function subtree(name) {
    const rows = await readTree(page);
    const start = rows.findIndex((row) => row.level === 1 && row.label === name);
    if (start < 0) {
      return [
        `(no connection "${name}" among ${JSON.stringify(rows.filter((row) => row.level === 1).map((row) => row.label))})`,
      ];
    }
    const end = rows.findIndex((row, index) => index > start && row.level === 1);
    return rows
      .slice(start, end < 0 ? rows.length : end)
      .map(
        ({ label, description, level }) =>
          `${'  '.repeat(level - 1)}${label}${description ? ` : ${description}` : ''}`,
      );
  }
  const showsExactly = (name, lines) =>
    expect.poll(() => subtree(name), { message: `the tree of "${name}"` }).toEqual(lines);

  /** Clicks an inline action of a connection row (the icons that appear when the pointer is over the row). */
  async function clickAction(name, action) {
    const row = treeRow(page, name, { level: 1 });
    await row.hover();
    await row.locator(`.actions a.action-label[aria-label="${action}"]`).click();
  }

  /** The default width cuts the messages off; a wider side bar shows them (and the screenshots can be read). */
  async function widenSidebar() {
    await eventually(async () => {
      const box = await sidebar(page).boundingBox();
      if (box.width > 600) {
        return;
      }
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width + 450, y, { steps: 10 });
      await page.mouse.up();
      expect((await sidebar(page).boundingBox()).width).toBeGreaterThan(600);
    });
  }

  const crop = (label) => t.shot(label, sidebar(page));
  const root = (name) => treeRow(page, name, { level: 1 });

  /** Expands a connection that cannot be opened and checks what the user sees: the state and the message. */
  async function fails(name, message, { shot } = {}) {
    const kind = PROFILES.find((profile) => profile.name === name).kind;
    await expandNode(page, name, { level: 1 });
    await showsExactly(name, [`${name} : ${kind} · connection failed`, `  ${message}`]);
    if (shot) {
      await crop(shot);
    }
    await collapseNode(page, name, { level: 1 });
  }

  const settingsOf = async () => (await t.server.readJson(MACHINE_SETTINGS))['aantje.connections'];

  await t.step(
    'the files and the settings are in place and the explorer lists every connection',
    async () => {
      await installDuckdbApi(t.server);
      await t.server.writeFile(
        TOOL,
        await readFile(new URL('../lib/files-errors-lake-tool.mjs', import.meta.url), 'utf8'),
      );
      const fixture = (name) => quote(`${FIXTURES}/${name}`);
      await sh(
        [
          `rm -rf ${LAKES}`,
          `mkdir -p ${LAKES}`,
          `cd ${LAKES}`,
          `cp ${fixture('ducklake.duckdb')} ducklake.duckdb`,
          `cp ${fixture('ducklake.duckdb')} locked.duckdb`,
          `cp ${fixture('ducklake.sqlite')} wal.sqlite`,
          `cp ${fixture('ducklake.sqlite')} future.sqlite`,
          'echo "These are my notes, not a database." > notes.txt',
          ': > empty.sqlite',
          ': > empty.duckdb',
        ].join(' && '),
      );
      await tool('sqlite', `${LAKES}/plain.sqlite`, 'CREATE TABLE notes (text TEXT)');
      await tool('duckdb', `${LAKES}/plain.duckdb`, 'CREATE TABLE notes (text VARCHAR)');
      await tool(
        'sqlite',
        `${LAKES}/future.sqlite`,
        "UPDATE ducklake_metadata SET value = '2.0' WHERE key = 'version'",
      );
      // A catalog whose query for the latest snapshot takes practically for ever: the view does the work on every read.
      await tool(
        'duckdb',
        `${LAKES}/slow.duckdb`,
        "CREATE TABLE ducklake_metadata AS SELECT 'version' AS key, '1.1' AS value, NULL::BIGINT AS scope, NULL::BIGINT AS scope_id;" +
          'CREATE VIEW ducklake_snapshot AS SELECT CAST(max(hash(i) % 100) AS BIGINT) AS snapshot_id FROM range(100000000000) t(i)',
      );

      const settings = await t.server.readJson(MACHINE_SETTINGS);
      await t.server.writeFile(
        MACHINE_SETTINGS,
        JSON.stringify({ ...settings, 'aantje.connections': PROFILES }),
      );
      await openWorkbench(page, { url: t.url });
      await openView(page, 'aantje');
      await widenSidebar();
      await expect
        .poll(async () => (await readTree(page)).map((row) => `${row.label} : ${row.description}`))
        .toEqual(PROFILES.map((profile) => `${profile.name} : ${profile.kind}`));
      await crop('connections');
    },
  );

  await t.step('a DuckDB catalog opens with the native binding of the linux-x64 package', async () => {
    const fileBefore = await t.server.sha256(`${LAKES}/ducklake.duckdb`);
    await expandNode(page, 'DuckDB lake', { level: 1 });
    await expandNode(page, 'sales', { level: 2 });
    await expandNode(page, 'Tables', { level: 3 });
    await expandNode(page, 'orders', { level: 4 });
    await expandNode(page, 'Columns', { level: 5 });
    await expandNode(page, 'customer', { level: 6 });
    await showsExactly('DuckDB lake', FIXTURE_TREE('DuckDB lake : duckdb · DuckLake 1.1 · @13'));
    await expect(statusBarItem(page, 'DuckDB lake')).toContainText(
      'DuckDB lake · DuckLake 1.1 · latest (@13)',
    );
    await crop('duckdb-tree');

    // The proof that it is the engine and not something else: the extension host has the library of the VSIX mapped.
    const mapped = await sh(
      "grep -l 'node-bindings-linux-x64/libduckdb' /proc/[0-9]*/maps 2>/dev/null | head -n 1; true",
    );
    expect(mapped.trim(), 'a process of the container has libduckdb.so of the extension mapped').toMatch(
      /^\/proc\/\d+\/maps$/,
    );
    expect(await t.server.readLog('teitelberg.aantje/aantje.log')).toContain(
      'Connected to "DuckDB lake" (DuckLake 1.1, latest snapshot 13).',
    );

    // Read-only for real: the file is byte for byte the same, and no write-ahead log or temporary file appeared.
    expect(await t.server.sha256(`${LAKES}/ducklake.duckdb`)).toBe(fileBefore);
    expect((await sh(`ls ${LAKES}/ | grep -E '^ducklake.duckdb' `)).trim().split('\n')).toEqual([
      'ducklake.duckdb',
    ]);

    const tooltip = await hoverText(page, treeRow(page, 'orders'));
    expect(tooltip).toContain('Rows in data files (inlined rows not included): 2');
    await collapseNode(page, 'DuckDB lake', { level: 1 });
  });

  await t.step('a catalog of DuckLake specification 1.0 works as well', async () => {
    await expandNode(page, 'Spec 1.0 lake', { level: 1 });
    await expandNode(page, 'sales', { level: 2 });
    await expandNode(page, 'Tables', { level: 3 });
    await expandNode(page, 'orders', { level: 4 });
    await expandNode(page, 'Columns', { level: 5 });
    await expandNode(page, 'customer', { level: 6 });
    await showsExactly('Spec 1.0 lake', FIXTURE_TREE('Spec 1.0 lake : sqlite · DuckLake 1.0 · @13'));
    await crop('spec-1-0-tree');
    await collapseNode(page, 'Spec 1.0 lake', { level: 1 });
  });

  await t.step('a file that is missing, no database or no DuckLake is explained in the tree', async () => {
    await fails('Missing SQLite file', `Cannot read "${LAKES}/missing.sqlite": ENOENT.`, {
      shot: 'error-missing-file',
    });
    await fails('Text as SQLite', `"${LAKES}/notes.txt" is not a valid SQLite database.`, {
      shot: 'error-text-as-sqlite',
    });
    await fails('Text as DuckDB', `"${LAKES}/notes.txt" is not a valid DuckDB database file.`, {
      shot: 'error-text-as-duckdb',
    });
    await fails('Empty SQLite file', NOT_A_DUCKLAKE);
    await fails('Empty DuckDB file', `"${LAKES}/empty.duckdb" is not a valid DuckDB database file.`);
    await fails('Plain SQLite', NOT_A_DUCKLAKE, { shot: 'error-not-a-ducklake' });
    await fails('Plain DuckDB', NOT_A_DUCKLAKE);
    await fails(
      'Future version',
      'The DuckLake specification version "2.0" is not supported. aantje reads catalogs of version 1.x.',
      { shot: 'error-unsupported-version' },
    );
  });

  await t.step('a PostgreSQL server that is not there is explained with host and port', async () => {
    await fails(
      'No such host',
      'Cannot connect to no-such-host.invalid:5432: the host name could not be resolved.',
      {
        shot: 'error-postgres-host',
      },
    );
    await fails(
      'Closed port',
      `Cannot connect to ${pg.host}:1: connection refused (is the server running on this port?).`,
      {
        shot: 'error-postgres-port',
      },
    );
  });

  await t.step('the Connect action of a failed connection reports the reason in a message', async () => {
    await clickAction('Missing SQLite file', 'Connect');
    const message = await waitForNotification(page, /^Cannot connect to/);
    expect(message).toBe(
      `Cannot connect to "Missing SQLite file": Cannot read "${LAKES}/missing.sqlite": ENOENT.`,
    );
    await t.shot('error-connect-message');
    await dismissNotifications(page);
  });

  await t.step('the tooltip of a failed connection holds the reason', async () => {
    const tooltip = await hoverText(page, root('Future version'));
    expect(tooltip).toContain('Future version (sqlite)');
    expect(tooltip).toContain(`File: ${LAKES}/future.sqlite`);
    expect(tooltip).toContain('The DuckLake specification version "2.0" is not supported.');
  });

  await t.step('Test Connection says whether a connection works', async () => {
    await chooseFromContextMenu(page, root('Plain SQLite'), 'Test Connection');
    expect(await waitForNotification(page, /^Connection test failed/)).toBe(
      `Connection test failed: ${NOT_A_DUCKLAKE}`,
    );
    await t.shot('error-test-connection');
    await dismissNotifications(page);

    await chooseFromContextMenu(page, root('DuckDB lake'), 'Test Connection');
    expect(await waitForNotification(page, /^The connection "DuckDB lake" works/)).toBe(
      'The connection "DuckDB lake" works. DuckLake spec version 1.1, latest snapshot 13.',
    );
    await dismissNotifications(page);
  });

  await t.step(
    'a SQLite catalog with an uncheckpointed write-ahead log is refused until the writer is done',
    async () => {
      const writer = await startHolder('hold-wal', `${LAKES}/wal.sqlite`);
      expect(Number((await sh(`stat -c %s ${quote(`${LAKES}/wal.sqlite-wal`)}`)).trim())).toBeGreaterThan(0);
      await fails(
        'WAL SQLite',
        `"${LAKES}/wal.sqlite" has an uncheckpointed write-ahead log. Close the application that writes to it or run a checkpoint, then connect again.`,
        { shot: 'error-wal' },
      );

      // The writer closes its file, which checkpoints the log; connecting again works.
      await writer.stop();
      await eventually(async () =>
        expect(
          (await t.server.exec(`test -s ${quote(`${LAKES}/wal.sqlite-wal`)}`)).code,
          'the log is empty or gone',
        ).not.toBe(0),
      );
      await clickAction('WAL SQLite', 'Connect');
      await showsExactly('WAL SQLite', SCHEMAS('WAL SQLite : sqlite · DuckLake 1.1 · @13'));
      await crop('retry-wal');
      await collapseNode(page, 'WAL SQLite', { level: 1 });
    },
  );

  await t.step(
    'a DuckDB file that another application has open for writing is LOCKED until it lets go',
    async () => {
      const writer = await startHolder('hold-duckdb', `${LAKES}/locked.duckdb`);
      const locked = `"${LAKES}/locked.duckdb" is in use by another application that has it open for writing, for example a notebook or script that attached the DuckLake. Close it there (or detach the catalog), then connect again.`;
      await fails('Locked DuckDB', locked, { shot: 'error-locked' });

      await chooseFromContextMenu(page, root('Locked DuckDB'), 'Test Connection');
      expect(await waitForNotification(page, /^Connection test failed/)).toBe(
        `Connection test failed: ${locked}`,
      );
      await dismissNotifications(page);

      await writer.stop();
      await clickAction('Locked DuckDB', 'Connect');
      await showsExactly('Locked DuckDB', SCHEMAS('Locked DuckDB : duckdb · DuckLake 1.1 · @13'));
      await crop('retry-locked');
    },
  );

  await t.step(
    'while aantje is connected to a DuckDB file, a writer cannot open it, readers can',
    async () => {
      const file = `${LAKES}/locked.duckdb`;
      const refused = (await tool('duckdb-open', file, 'rw')).trim();
      // The limit that the documentation names: the message of DuckDB, naming the process that holds the lock.
      expect(refused).toMatch(
        /^IO Error: Could not set lock on file "[^"]+locked\.duckdb": Conflicting lock is held in .+ \(PID \d+\)/,
      );
      // DuckDB names the process that holds the lock: the extension host of code-server, where aantje runs.
      const holderPid = refused.match(/\(PID (\d+)\)/)[1];
      expect(await t.server.readFile(`/proc/${holderPid}/cmdline`)).toContain('extensionHost');
      t.warn(
        `a writer is refused while aantje is connected (documented limit): ${refused.replace(/\. (See also|However).*/, '')}`,
      );
      expect((await tool('duckdb-open', file, 'ro')).trim(), 'a second reader can share the file').toBe(
        'opened',
      );

      await clickAction('Locked DuckDB', 'Disconnect');
      await eventually(async () => expect((await tool('duckdb-open', file, 'rw')).trim()).toBe('opened'), {
        timeout: 30_000,
      });
      await showsExactly('Locked DuckDB', ['Locked DuckDB : duckdb']);
      await clickAction('Locked DuckDB', 'Connect');
      await expect
        .poll(() => subtree('Locked DuckDB'))
        .toContain('Locked DuckDB : duckdb · DuckLake 1.1 · @13');
      await collapseNode(page, 'Locked DuckDB', { level: 1 });
    },
  );

  await t.step(
    'a connection that failed because the file was missing works once the file exists',
    async () => {
      await fails('Late DuckDB', `Cannot read "${LAKES}/late.duckdb": ENOENT.`);
      await sh(`cp ${quote(`${FIXTURES}/ducklake.duckdb`)} ${quote(`${LAKES}/late.duckdb`)}`);
      await clickAction('Late DuckDB', 'Connect');
      await expect.poll(() => subtree('Late DuckDB')).toContain('Late DuckDB : duckdb · DuckLake 1.1 · @13');
      await collapseNode(page, 'Late DuckDB', { level: 1 });
    },
  );

  await t.step('the wizard reports a failed test and offers to edit, save anyway or cancel', async () => {
    const q = quickInput(page);
    const missing = `${LAKES}/wizard.duckdb`;
    await runCommand(page, 'aantje: Add Connection...');
    await pick(page, 'DuckDB', { title: 'Add Connection: where is the DuckLake metadata stored?' });
    await input(page, 'Wizard lake', { title: 'Add Connection (1/3)' });

    await expect(q.title).toHaveText('Add Connection (2/3)');
    await q.input.fill(`"${missing}"`);
    await expect(q.message).toContainText('Remove the quotes around the path.');
    await input(page, missing, { title: 'Add Connection (2/3)' });
    // A new DuckDB connection starts read-only: a writable session would lock the file for the explorer.
    await expect(q.title).toHaveText(READ_ONLY_TITLE);
    expect(await q.labels()).toEqual(['Yes', 'No']);
    await t.shot('wizard-duckdb-read-only-question');
    await pick(page, 'Yes', { title: READ_ONLY_TITLE });

    expect(await waitForNotification(page, /^Connection test failed/)).toBe(
      `Connection test failed: Cannot read "${missing}": ENOENT.`,
    );
    await expect(q.title).toHaveText('The connection test failed');
    expect(await q.labels()).toEqual(['Save anyway', 'Edit settings', 'Cancel']);
    await t.shot('error-wizard-test-failed');
    expect(await settingsOf(), 'nothing is saved before the user decides').toHaveLength(PROFILES.length);

    await pick(page, 'Edit settings');
    await input(page, 'Wizard lake', { title: 'Add Connection (1/3)' });
    await expect(q.input).toHaveValue(missing);
    await sh(`cp ${quote(`${FIXTURES}/ducklake.duckdb`)} ${quote(missing)}`);
    await input(page, missing, { title: 'Add Connection (2/3)' });
    await pick(page, 'Yes', { title: READ_ONLY_TITLE });
    // The workbench shows at most three toasts. The error toast of the first attempt is still there, and so can be
    // the progress toast of the test, so the toast of the success may never be shown. The notification center keeps
    // every message, so that is where the spec looks.
    const saved = 'Saved connection "Wizard lake". DuckLake spec version 1.1, latest snapshot 13.';
    await runCommand(page, 'Notifications: Show Notifications');
    await expect(
      page.locator('.notifications-center .notification-list-item-message').filter({ hasText: saved }),
    ).toHaveCount(1);
    await dismissNotifications(page);
    expect((await settingsOf()).at(-1)).toEqual({
      id: 'wizard-lake',
      name: 'Wizard lake',
      kind: 'duckdb',
      path: missing,
      readOnly: true,
    });
    await expect(root('Wizard lake')).toBeVisible();
  });

  await t.step(
    'a PostgreSQL database that does not exist is reported by name, and the password stays out of the files',
    async () => {
      const q = quickInput(page);
      await runCommand(page, 'aantje: Add Connection...');
      await pick(page, 'PostgreSQL', { title: 'Add Connection: where is the DuckLake metadata stored?' });
      await input(page, 'Wrong database', { title: 'Add Connection (1/9)' });
      await input(page, pg.host, { title: 'Add Connection (2/9)' });
      await input(page, String(pg.port), { title: 'Add Connection (3/9)' });
      await input(page, 'no_such_database', { title: 'Add Connection (4/9)' });
      await pick(page, 'Password', { title: 'Add Connection (5/9): How do you sign in to PostgreSQL?' });
      await input(page, pg.user, { title: 'Add Connection (6/9)' });
      await pick(page, 'No', { title: 'Add Connection (7/9): Use TLS for the connection?' });
      await input(page, pg.password, { title: 'Add Connection (8/9)' });
      await pick(page, 'No', { title: 'Add Connection (9/9): Open SQL editor sessions read-only?' });

      expect(await waitForNotification(page, /^Connection test failed/)).toBe(
        `Connection test failed: Cannot connect to ${pg.host}:${pg.port}: database "no_such_database" does not exist.`,
      );
      await expect(q.title).toHaveText('The connection test failed');
      await t.shot('error-postgres-database');
      await pick(page, 'Save anyway');
      await dismissNotifications(page);

      const profile = (await settingsOf()).at(-1);
      expect(profile).toEqual({
        id: 'wrong-database',
        name: 'Wrong database',
        kind: 'postgres',
        host: pg.host,
        port: pg.port,
        database: 'no_such_database',
        user: pg.user,
        ssl: false,
      });
      await expandNode(page, 'Wrong database', { level: 1 });
      await showsExactly('Wrong database', [
        'Wrong database : postgres · connection failed',
        `  Cannot connect to ${pg.host}:${pg.port}: database "no_such_database" does not exist.`,
      ]);
      await crop('error-postgres-database-tree');
      await collapseNode(page, 'Wrong database', { level: 1 });

      // Nothing the user typed as a password is in a settings file or in the log of the extension.
      const files = await sh(
        `cat ${quote(MACHINE_SETTINGS)} ${quote(MACHINE_SETTINGS.replace('Machine', 'User'))}`,
      );
      expect(files).not.toContain(pg.password);
      expect(await t.server.readLog('teitelberg.aantje/aantje.log')).not.toContain(pg.password);
    },
  );

  await t.step(
    'after all these failures the working connections still work, also after a refresh of everything',
    async () => {
      await expandNode(page, 'Fixture lake', { level: 1 });
      await showsExactly('Fixture lake', SCHEMAS('Fixture lake : sqlite · DuckLake 1.1 · @13'));
      await page
        .locator(
          '.pane-header .actions a.action-label[aria-label="Refresh"], .title-actions a.action-label[aria-label="Refresh"]',
        )
        .first()
        .click();
      await showsExactly('Fixture lake', SCHEMAS('Fixture lake : sqlite · DuckLake 1.1 · @13'));
      await crop('after-failures');
      await collapseNode(page, 'Fixture lake', { level: 1 });
      expect(await notificationTexts(page)).toEqual([]);
    },
  );

  await t.step(
    'with aantje.queryTimeoutSeconds set to 1 a catalog that answers too slowly is cut off',
    async () => {
      const settings = await t.server.readJson(MACHINE_SETTINGS);
      await t.server.writeFile(
        MACHINE_SETTINGS,
        JSON.stringify({ ...settings, 'aantje.queryTimeoutSeconds': 1 }),
      );
      await t.server.restart();
      await openWorkbench(page, { url: t.url });
      await openView(page, 'aantje');
      await widenSidebar();

      await expandNode(page, 'Slow DuckDB', { level: 1 });
      await showsExactly('Slow DuckDB', [
        'Slow DuckDB : duckdb · connection failed',
        '  The catalog query exceeded the time limit of 1 s and was cancelled.',
      ]);
      await crop('error-query-timeout');
      await collapseNode(page, 'Slow DuckDB', { level: 1 });

      // The limit is not a trap for catalogs that answer in time, and the process is free again afterwards.
      await expandNode(page, 'DuckDB lake', { level: 1 });
      await showsExactly('DuckDB lake', SCHEMAS('DuckDB lake : duckdb · DuckLake 1.1 · @13'));
    },
  );
}
