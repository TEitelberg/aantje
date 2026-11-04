import {
  MACHINE_SETTINGS,
  activeTab,
  chooseFromContextMenu,
  chooseFromSubmenu,
  collapseNode,
  contextMenuItems,
  diffEditorTexts,
  disabledSubmenuItems,
  dismissNotifications,
  editorText,
  expandNode,
  expect,
  hoverText,
  openView,
  openWorkbench,
  outline,
  pick,
  quickInput,
  readTree,
  runCommand,
  scrollToRow,
  submenuItems,
  treeRow,
  waitForNotification,
} from '../lib/index.mjs';
import {
  changesTab,
  gridTab,
  installHistoryFixture,
  readGrid,
  runTool,
} from '../lib/data-features-support.mjs';
import { queryStatusText } from '../lib/sql-editor-support.mjs';
import {
  aantjeStatusText,
  clickInlineAction,
  inlineActionLabels,
  titleAction,
} from '../lib/tree-features-helpers.mjs';

export const title =
  'Time travel: scripts, macros, maintenance, snapshots, Query at Snapshot, Compare Schema, Compare Snapshots and the changes of a table';

const LAKE = 'Data lake';

// The text of main.evolving at the snapshots 30 and 35 (test/fixtures/history/README.md: the schema evolution).
const EVOLVED_AT_30 = `CREATE TABLE "main"."evolving" (
  "id" INTEGER,
  "title" VARCHAR,
  "info" STRUCT("a" INTEGER, "b" VARCHAR),
  "n" BIGINT,
  "extra" DOUBLE
);`;
const EVOLVED_AT_35 = `CREATE TABLE "main"."evolved" (
  "id" INTEGER,
  "title" VARCHAR,
  "info" STRUCT("a" INTEGER, "b" VARCHAR, "c" DOUBLE),
  "n" BIGINT,
  "flag" BOOLEAN DEFAULT true
);`;

// What Open as SQL writes for main.evolved at snapshot 30: the name and the columns of that snapshot, a comment names it.
const EVOLVED_SELECT_AT_30 = `-- Time travel to snapshot 30
SELECT
  "id",
  "title",
  "info",
  "n",
  "extra"
FROM "main"."evolving" AT (VERSION => 30)
LIMIT 1000;`;

// The template of Script as ALTER for a table: every statement is a comment (docs/en/ddl.md).
const ALTER_HEADER = `-- Every statement in this script is commented out, so running it changes nothing.
-- Remove the "-- " in front of the statements you want, replace the <placeholders> and run them in a read/write SQL session.
-- DuckLake can add, rename and drop columns and struct fields, change a column type (only widening, for example INTEGER to BIGINT), rename the table, and set the comment, the partitioning, the sort order and the options.`;
const DROP_FIRST = '-- To drop it before it is created again, remove the "-- " of the next line.';
const alterTemplate = (table, columns) =>
  [
    ALTER_HEADER,
    `-- Add a column\n-- ALTER TABLE ${table} ADD COLUMN <new_column> <type>;`,
    `-- Rename the table\n-- ALTER TABLE ${table} RENAME TO <new_name>;`,
    `-- Comment on the table\n-- COMMENT ON TABLE ${table} IS '<comment>';`,
    `-- Partitioning of new data\n-- ALTER TABLE ${table} SET PARTITIONED BY (<column>);\n-- ALTER TABLE ${table} RESET PARTITIONED BY;`,
    `-- Sort order of new data\n-- ALTER TABLE ${table} SET SORTED BY (<column> ASC);\n-- ALTER TABLE ${table} RESET SORTED BY;`,
    ...columns.map(
      (name, index) =>
        `-- Column ${index + 1} of ${columns.length}
-- ALTER TABLE ${table} RENAME COLUMN "${name}" TO <new_name>;
-- ALTER TABLE ${table} ALTER COLUMN "${name}" SET DATA TYPE <new_type>;
-- ALTER TABLE ${table} DROP COLUMN "${name}";
-- COMMENT ON COLUMN ${table}."${name}" IS '<comment>';`,
    ),
    `-- Drop the table\n-- DROP TABLE ${table};`,
  ].join('\n\n');
/** Script as ALTER without its block of table options, whose lines the unit tests of the template check. */
const withoutOptions = (text) =>
  text
    .split('\n\n')
    .filter((block) => !block.startsWith('-- Options of the table'))
    .join('\n\n');

const CUSTOMER_COLUMNS = [
  'snapshot_id BIGINT',
  'rowid BIGINT',
  'change_type VARCHAR',
  'id INTEGER',
  'name VARCHAR',
  'tier VARCHAR',
];

/** The statements of a script: its lines that are neither empty nor a comment. */
const statementsOf = (text) => text.split('\n').filter((line) => line !== '' && !line.startsWith('--'));

export default async function timeTravel(t) {
  const { page, server } = t;
  const q = quickInput(page);
  const status = () => aantjeStatusText(page);
  const times = new Map();
  let catalog;

  const collapseAll = async () => {
    await titleAction(page, 'Collapse All').click();
    await expect.poll(async () => (await outline(page)).filter((line) => line.startsWith('  '))).toEqual([]);
  };
  // A table has no order of its own: the rows of a snapshot are compared by id.
  const byId = (rows) => rows.map((row) => row.map((cell) => cell.text)).sort((a, b) => a[0] - b[0]);
  const customers = () => treeRow(page, 'customers');
  const evolved = () => treeRow(page, 'evolved');
  /** The tabs of a grid or a diff editor that are open, by their titles. */
  const tabTitles = async () => page.getByRole('tab').allTextContents();
  /** The number of the last untitled document that was opened; every script and report opens a new one. */
  let untitled = 0;
  const opened = async () => {
    untitled += 1;
    await expect(activeTab(page)).toContainText(`Untitled-${untitled}`);
  };
  const scriptAs = async (row, label) => {
    await chooseFromSubmenu(page, row, 'Script as', label);
    await opened();
  };
  const maintenance = async (row, label) => {
    await chooseFromSubmenu(page, row, 'Maintenance', label);
    await opened();
  };
  /** Opens the submenu Time Travel of a table and chooses an item. */
  const timeTravelItem = (row, label) => chooseFromSubmenu(page, row, 'Time Travel', label);

  await t.step('prepare: the history catalog (57 snapshots, Parquet files) as a connection', async () => {
    catalog = await installHistoryFixture(server);
    // DuckDB loads its extensions on first use; the harness fetches them once, so that the steps below do not wait for the net.
    await runTool(server, ['prefetch'], { timeoutSeconds: 300 });
    const settings = await server.readJson(MACHINE_SETTINGS);
    await server.writeFile(
      MACHINE_SETTINGS,
      JSON.stringify({
        ...settings,
        'aantje.connections': [{ id: 'data-lake', name: LAKE, kind: 'sqlite', path: catalog }],
      }),
    );
    await openWorkbench(page, { url: t.url });
    await openView(page, 'aantje');
    await runCommand(page, 'View: Toggle Secondary Side Bar Visibility');
    await treeRow(page, LAKE).click();
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(() => outline(page))
      .toEqual([`${LAKE} : sqlite · DuckLake 1.1 · @56`, '  main', '  shop', '  Snapshots']);
  });

  await t.step(
    'Script as DROP is shown on the schema main, but disabled; on another schema it is enabled',
    async () => {
      const main = treeRow(page, 'main', { level: 2 });
      const shop = treeRow(page, 'shop', { level: 2 });
      expect(await submenuItems(page, main, 'Script as')).toEqual(
        await submenuItems(page, shop, 'Script as'),
      );
      expect(await submenuItems(page, main, 'Script as')).toContain('Script as DROP');
      expect(await disabledSubmenuItems(page, main, 'Script as')).toEqual(['Script as DROP']);
      expect(await disabledSubmenuItems(page, shop, 'Script as')).toEqual([]);
    },
  );

  await t.step(
    'Script as SELECT, INSERT, CREATE, ALTER and DROP open an untitled SQL document with the text of the table',
    async () => {
      await expandNode(page, 'shop');
      await expect
        .poll(async () => (await readTree(page)).filter((row) => row.level === 3).map((row) => row.label))
        .toEqual(['Tables', 'Views', 'Macros']);
      await expandNode(page, 'Tables', { level: 3 });
      expect(await submenuItems(page, customers(), 'Script as')).toEqual([
        'Script as SELECT',
        'Script as INSERT',
        'Script as CREATE',
        'Script as ALTER',
        'Script as DROP',
      ]);

      await scriptAs(customers(), 'Script as CREATE');
      expect(await editorText(page)).toBe(
        [
          DROP_FIRST,
          '-- DROP TABLE "shop"."customers";',
          'CREATE TABLE "shop"."customers" (',
          '  "id" INTEGER NOT NULL,',
          '  "name" VARCHAR,',
          '  "tier" VARCHAR',
          ');',
          '-- The partitioning, the sort order and the comments of the table',
          `-- COMMENT ON TABLE "shop"."customers" IS 'Customers of the shop';`,
          `-- COMMENT ON COLUMN "shop"."customers"."tier" IS 'bronze, silver or gold';`,
        ].join('\n'),
      );
      await t.shot('script-create');

      await scriptAs(customers(), 'Script as SELECT');
      expect(await editorText(page)).toBe(
        ['SELECT', '  "id",', '  "name",', '  "tier"', 'FROM "shop"."customers"', 'LIMIT 1000;'].join('\n'),
      );
      await t.shot('script-select');
      // The document belongs to the lake: the status bar of the SQL editor names it. Nothing was run.
      await expect.poll(() => queryStatusText(page)).toBe(`${LAKE} · read/write`);

      // One row with a placeholder per column; it does not run until the placeholders are replaced.
      await scriptAs(customers(), 'Script as INSERT');
      expect(statementsOf(await editorText(page))).toEqual([
        'INSERT INTO "shop"."customers" ("id", "name", "tier")',
        'VALUES (',
        '  <"id" INTEGER NOT NULL>,',
        '  <"name" VARCHAR>,',
        '  <"tier" VARCHAR>',
        ');',
      ]);
      await t.shot('script-insert');

      await scriptAs(customers(), 'Script as ALTER');
      const alter = await editorText(page);
      expect(alter).toMatch(/^-- ALTER TABLE "shop"\."customers" SET \(.+\);$/m);
      expect(alter).toMatch(/^-- ALTER TABLE "shop"\."customers" RESET \(.+\);$/m);
      expect(withoutOptions(alter)).toBe(alterTemplate('"shop"."customers"', ['id', 'name', 'tier']));
      await t.shot('script-alter');

      await scriptAs(customers(), 'Script as DROP');
      expect(await editorText(page)).toBe(
        '-- Drops the table. Run it in a read/write SQL session.\nDROP TABLE "shop"."customers";',
      );
      await t.shot('script-drop');
    },
  );

  await t.step('a view has Script as SELECT, CREATE, ALTER (CREATE OR REPLACE VIEW) and DROP', async () => {
    await expandNode(page, 'Views', { level: 3 });
    const view = treeRow(page, 'big_events');
    await expect(view).toBeVisible();
    expect(await submenuItems(page, view, 'Script as')).toEqual([
      'Script as SELECT',
      'Script as CREATE',
      'Script as ALTER',
      'Script as DROP',
    ]);
    // A view has no Compare Schema and no Show Changes, and its reports are the dependencies.
    expect(await submenuItems(page, view, 'Time Travel')).toEqual(['Query at Snapshot...']);
    expect(await submenuItems(page, view, 'Reports')).toEqual(['Dependencies']);

    await scriptAs(view, 'Script as SELECT');
    expect(await editorText(page)).toBe('SELECT *\nFROM "shop"."big_events"\nLIMIT 1000;');
    await scriptAs(view, 'Script as ALTER');
    const alter = await editorText(page);
    expect(alter.split('\n')[0]).toBe(
      '-- Edit the query, then run the statement in a read/write SQL session to replace the view.',
    );
    expect(statementsOf(alter)).toEqual([
      expect.stringMatching(
        /^CREATE OR REPLACE VIEW "shop"\."big_events" AS SELECT \* FROM shop\.events WHERE /,
      ),
    ]);
    expect(alter.split('\n').slice(-1)).toEqual(['-- DROP VIEW "shop"."big_events";']);
    await scriptAs(view, 'Script as DROP');
    expect(await editorText(page)).toBe(
      '-- Drops the view. Run it in a read/write SQL session.\nDROP VIEW "shop"."big_events";',
    );
    await collapseNode(page, 'Views', { level: 3 });
  });

  await t.step(
    'macros: the folder lists them, a macro has SELECT, CREATE, ALTER and DROP, the folder a template',
    async () => {
      await expandNode(page, 'Macros', { level: 3 });
      const macroRows = async () =>
        (await readTree(page))
          .filter((row) => row.level === 4 && /^(gross|recent_events)$/.test(row.label))
          .map(({ label, description }) => [label, description]);
      await expect.poll(macroRows).toEqual([
        ['gross', 'scalar (net, rate := 1.19)'],
        ['recent_events', 'table (n)'],
      ]);
      const gross = treeRow(page, 'gross');
      expect(await contextMenuItems(page, gross)).toEqual(['Script as', 'Reports']);
      expect(await submenuItems(page, gross, 'Script as')).toEqual([
        'Script as SELECT',
        'Script as CREATE',
        'Script as ALTER',
        'Script as DROP',
      ]);
      expect(await submenuItems(page, gross, 'Reports')).toEqual(['Dependencies']);

      const create = 'CREATE OR REPLACE MACRO "shop"."gross"("net", "rate" := 1.19) AS (net * rate);';
      await scriptAs(gross, 'Script as CREATE');
      expect(await editorText(page)).toBe([DROP_FIRST, '-- DROP MACRO "shop"."gross";', create].join('\n'));
      await scriptAs(gross, 'Script as ALTER');
      expect(await editorText(page)).toBe(
        `-- Edit the macro, then run the statement in a read/write SQL session to replace it. The statement holds all its overloads.\n${create}\n-- Drop the macro\n-- DROP MACRO "shop"."gross";`,
      );
      await scriptAs(gross, 'Script as SELECT');
      expect(await editorText(page)).toBe(
        '-- Replace the <arg> placeholders with values.\nSELECT "shop"."gross"(<arg1>);',
      );
      await scriptAs(gross, 'Script as DROP');
      expect(await editorText(page)).toBe(
        '-- Drops the scalar macro with all its overloads. Run it in a read/write SQL session.\nDROP MACRO "shop"."gross";',
      );
      // A table macro is dropped with DROP MACRO TABLE.
      await scriptAs(treeRow(page, 'recent_events'), 'Script as DROP');
      expect(await editorText(page)).toBe(
        '-- Drops the table macro with all its overloads. Run it in a read/write SQL session.\nDROP MACRO TABLE "shop"."recent_events";',
      );

      // The folder offers the template with two examples that run as they are.
      const folder = treeRow(page, 'Macros', { level: 3 });
      expect(await contextMenuItems(page, folder)).toEqual(['Script as']);
      expect(await submenuItems(page, folder, 'Script as')).toEqual([
        'Script as SELECT',
        'Script as CREATE',
        'Script as DROP',
      ]);
      await scriptAs(folder, 'Script as CREATE');
      const template = await editorText(page);
      expect(template.startsWith('-- Two examples of a macro in this schema.')).toBe(true);
      expect(statementsOf(template)).toEqual([
        'CREATE MACRO "shop"."add_one"(x) AS x + 1;',
        'CREATE MACRO "shop"."first_rows"(n := 10) AS TABLE SELECT 42 AS answer FROM range(n);',
      ]);
      await t.shot('macro-template');
      await collapseNode(page, 'Macros', { level: 3 });
    },
  );

  await t.step('Maintenance scripts open a document with the dry run active', async () => {
    const lake = treeRow(page, LAKE);
    expect(await submenuItems(page, lake, 'Maintenance')).toEqual([
      'Checkpoint',
      'Merge Adjacent Files',
      'Rewrite Data Files',
      'Flush Inlined Data',
      'Expire Snapshots',
      'Clean Up Old Files',
      'Delete Orphaned Files',
      'Set Option',
    ]);
    const events = treeRow(page, 'events');
    expect(await submenuItems(page, events, 'Maintenance')).toEqual([
      'Merge Adjacent Files',
      'Rewrite Data Files',
      'Flush Inlined Data',
      'Set Option',
    ]);

    await maintenance(lake, 'Checkpoint');
    const checkpoint = await editorText(page);
    expect(checkpoint.startsWith('-- Maintenance of the DuckLake.')).toBe(true);
    expect(statementsOf(checkpoint)).toEqual(['CHECKPOINT lake;']);

    // What destroys data starts with a dry run; the real call is a comment under it, with the warning.
    await maintenance(lake, 'Expire Snapshots');
    const expire = await editorText(page);
    expect(statementsOf(expire)).toEqual([
      "CALL ducklake_expire_snapshots('lake', older_than => now() - INTERVAL 30 DAY, dry_run => true);",
    ]);
    expect(expire).toContain(
      "-- CALL ducklake_expire_snapshots('lake', older_than => now() - INTERVAL 30 DAY);",
    );
    await t.shot('maintenance-expire');

    await maintenance(lake, 'Delete Orphaned Files');
    const orphans = await editorText(page);
    // Without older_than the call follows the option delete_older_than of the lake (2 days when it sets none).
    expect(statementsOf(orphans)).toEqual(["CALL ducklake_delete_orphaned_files('lake', dry_run => true);"]);
    expect(orphans).toContain(
      'a writer that is running at the moment (for example Sail) may have uploaded files',
    );

    // A table: the schema and the table are string literals.
    await maintenance(events, 'Merge Adjacent Files');
    expect(statementsOf(await editorText(page))).toEqual([
      "CALL ducklake_merge_adjacent_files('lake', 'events', schema => 'shop');",
    ]);
    await expect.poll(() => queryStatusText(page)).toBe(`${LAKE} · read/write`);
  });

  await t.step(
    'the Snapshots folder lists the 50 newest snapshots; a snapshot is its transaction',
    async () => {
      await collapseNode(page, 'shop');
      await expandNode(page, 'Snapshots');
      await scrollToRow(page, '@23');
      await expandNode(page, '@23');
      // Snapshot 23 is one transaction that changed two tables; each leaf names the table and the action.
      await expect(treeRow(page, 'shop.events', { level: 4 })).toBeVisible();
      await expect
        .poll(async () =>
          (await readTree(page))
            .filter((row) => row.level === 4)
            .map(({ label, description }) => [label, description]),
        )
        .toEqual([
          ['shop.events', 'Inserted into table'],
          ['shop.customers', 'Inserted into table'],
        ]);
      await t.shot('snapshot-23-transaction');
      await collapseNode(page, '@23');

      // The 50 newest of 57: @56 down to @7. The times are kept for the report of Compare Snapshots below.
      for (const id of [30, 35]) {
        await scrollToRow(page, `@${id}`);
        const row = (await readTree(page)).find((candidate) => candidate.label === `@${id}`);
        expect(row.description).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/);
        times.set(id, row.description);
      }
      await scrollToRow(page, '@7');
      await expect(treeRow(page, '@6')).toHaveCount(0);
    },
  );

  await t.step(
    'Show Catalog at this Snapshot pins the tree to the snapshot; the status bar follows',
    async () => {
      const row = await scrollToRow(page, '@23');
      expect(await inlineActionLabels(row)).toEqual(['Show Catalog at this Snapshot']);
      expect(await contextMenuItems(page, row)).toEqual(['Show Catalog at this Snapshot', 'Script as']);
      await clickInlineAction(row, 'Show Catalog at this Snapshot');
      await expect.poll(status).toBe(`${LAKE} · DuckLake 1.1 · @23 (pinned)`);
      await expect(treeRow(page, LAKE).locator('.label-description')).toHaveText(
        'sqlite · DuckLake 1.1 · @23 (pinned)',
      );
      await collapseAll();
      await expandNode(page, LAKE);
      // At snapshot 23 shop has four tables: audit (24), the views (39 and later) and the macros are not there yet.
      // The folder Macros is there all the same.
      await expandNode(page, 'shop');
      await expandNode(page, 'Tables', { level: 3 });
      await expect
        .poll(() => outline(page))
        .toEqual([
          `${LAKE} : sqlite · DuckLake 1.1 · @23 (pinned)`,
          '  main',
          '  shop',
          '    Tables',
          '      customers',
          '      events',
          '      notes',
          '      readings',
          '    Views',
          '    Macros',
          '  Snapshots',
        ]);
      // The rows are in the tooltip: events had 52 rows at snapshot 23.
      expect(await hoverText(page, treeRow(page, 'events'))).toContain(
        'Rows in data files (inlined rows not included): 52',
      );
      await t.shot('catalog-at-23');
    },
  );

  await t.step(
    'Query at Snapshot: the picker, then a grid whose title names the chosen snapshot',
    async () => {
      await expandNode(page, 'customers');
      await timeTravelItem(customers(), 'Query at Snapshot...');
      await expect(q.title).toHaveText('Query shop.customers at a snapshot');
      // customers exists from snapshot 15 on: 42 snapshots, newest first; the snapshot that the tree shows is highlighted.
      await expect(q.rows.first()).toBeVisible();
      await t.shot('query-at-snapshot-picker');
      await pick(page, '@16');
      await expect(q.title).toHaveText('Query shop.customers at @16');
      expect(await q.labels()).toEqual(['Top 1000 Rows', 'Create Notebook', 'Open as SQL']);
      await pick(page, 'Top 1000 Rows');

      await expect(gridTab(page, `shop.customers (top 1000) · ${LAKE} @16`)).toBeVisible();
      await expect.poll(async () => (await readGrid(page)).rows.length).toBe(4);
      const at16 = await readGrid(page);
      expect(at16.headers.map(({ name, type }) => `${name} ${type}`)).toEqual([
        'id INTEGER',
        'name VARCHAR',
        'tier VARCHAR',
      ]);
      expect(byId(at16.rows)).toEqual([
        ['1', 'ada', 'bronze'],
        ['2', 'bob', 'bronze'],
        ['3', 'cy', 'silver'],
        ['4', 'di', 'silver'],
      ]);
      await t.shot('customers-at-16');

      // Another snapshot is another panel: after the update (17) bob is gold, after the delete (18) di is gone.
      await timeTravelItem(customers(), 'Query at Snapshot...');
      await pick(page, '@18');
      await pick(page, 'Top 1000 Rows');
      await expect(gridTab(page, `shop.customers (top 1000) · ${LAKE} @18`)).toBeVisible();
      await expect.poll(async () => (await readGrid(page)).rows.length).toBe(3);
      expect(byId((await readGrid(page)).rows)).toEqual([
        ['1', 'ada', 'bronze'],
        ['2', 'bob', 'gold'],
        ['3', 'cy', 'silver'],
      ]);
      await expect(gridTab(page)).toHaveCount(2);
    },
  );

  await t.step('Compare Schema: the diff editor over the two snapshots and the summary message', async () => {
    // The tree shows snapshot 23 and the table evolving does not exist yet: back to the latest snapshot.
    await runCommand(page, 'aantje: Show Catalog at Snapshot...');
    await pick(page, 'Latest');
    await expect.poll(status).toBe(`${LAKE} · DuckLake 1.1 · latest (@56)`);
    await collapseNode(page, 'shop');
    await expandNode(page, 'main');
    await expandNode(page, 'Tables', { level: 3 });
    await dismissNotifications(page);

    expect(await submenuItems(page, evolved(), 'Time Travel')).toEqual([
      'Query at Snapshot...',
      'Compare Schema...',
      'Show Changes...',
    ]);
    await timeTravelItem(evolved(), 'Compare Schema...');
    await expect(q.title).toHaveText('Compare "main.evolved" (1/2)');
    await pick(page, '@30');
    await expect(q.title).toHaveText('Compare "main.evolved" (2/2)');
    // A is not offered a second time.
    expect(await q.row('@30').count()).toBe(0);
    await pick(page, '@35');

    expect(await waitForNotification(page, /between @30 and @35$/)).toBe(
      'table renamed, 2 columns added, 1 removed between @30 and @35',
    );
    await expect(page.getByRole('tab', { name: 'main.evolved: @30 ↔ @35' })).toBeVisible();
    expect(await diffEditorTexts(page)).toEqual({ original: EVOLVED_AT_30, modified: EVOLVED_AT_35 });
    await t.shot('compare-schema');
  });

  await t.step(
    'Query at Snapshot > Open as SQL opens the statement of that snapshot, with its names and columns',
    async () => {
      await dismissNotifications(page);
      await timeTravelItem(evolved(), 'Query at Snapshot...');
      await expect(q.title).toHaveText('Query main.evolved at a snapshot');
      await pick(page, '@30');
      await expect(q.title).toHaveText('Query main.evolved at @30');
      await pick(page, 'Open as SQL');

      // At snapshot 30 the table was called evolving and still had the column extra. Nothing is run by opening.
      await opened();
      expect(await editorText(page)).toBe(EVOLVED_SELECT_AT_30);
      await expect.poll(() => queryStatusText(page)).toBe(`${LAKE} · read/write`);
      await expect(gridTab(page).filter({ hasText: 'evolv' })).toHaveCount(0);
      await t.shot('open-as-sql');
    },
  );

  await t.step('Compare Snapshots: a Markdown report of what differs between two snapshots', async () => {
    expect(await contextMenuItems(page, treeRow(page, LAKE))).toEqual([
      'Test Connection',
      'Edit Connection...',
      'Remove Connection',
      'New Query',
      'Script as',
      'Maintenance',
      'Compare Snapshots...',
      'Show Catalog at Snapshot...',
      'Show Latest Snapshot',
      'Reports',
    ]);
    await chooseFromContextMenu(page, treeRow(page, LAKE), 'Compare Snapshots...');
    await expect(q.title).toHaveText(`Compare "${LAKE}" (1/2)`);
    await pick(page, '@30');
    await expect(q.title).toHaveText(`Compare "${LAKE}" (2/2)`);
    await pick(page, '@35');

    await opened();
    expect(await editorText(page)).toBe(
      [
        `# ${LAKE}: @30 to @35`,
        '',
        `- From: @30, ${times.get(30)}`,
        `- To: @35, ${times.get(35)}`,
        '',
        '## Tables and views',
        '',
        '### Renamed (1)',
        '',
        '- table `main.evolving` is now `main.evolved`',
        '',
        '## Columns',
        '',
        'Compared 6 tables that exist at both snapshots. 1 of them has column changes.',
        '',
        '### `main.evolved`',
        '',
        '- added `info.c` (`float64`)',
        '- added `flag` (`boolean`)',
        '- removed `extra` (`float64`)',
        '',
      ].join('\n'),
    );
    await t.shot('compare-snapshots');
  });

  await t.step('Show Changes: the rows of shop.customers between @15 and @18, marked by kind', async () => {
    await collapseNode(page, 'main');
    await expandNode(page, 'shop');
    await expandNode(page, 'Tables', { level: 3 });
    await timeTravelItem(customers(), 'Show Changes...');
    await expect(q.title).toHaveText('Show changes of shop.customers (1/2)');
    await pick(page, '@15');
    await expect(q.title).toHaveText('Show changes of shop.customers (2/2)');
    await pick(page, '@18');

    await expect(changesTab(page, `shop.customers changes @15 → @18 · ${LAKE}`)).toBeVisible();
    await expect.poll(async () => (await readGrid(page)).rows.length).toBe(7);
    const grid = await readGrid(page);
    expect(grid.headers.map(({ name, type }) => `${name} ${type}`)).toEqual(CUSTOMER_COLUMNS);
    expect(grid.rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ['16', '0', 'insert', '1', 'ada', 'bronze'],
      ['16', '1', 'insert', '2', 'bob', 'bronze'],
      ['16', '2', 'insert', '3', 'cy', 'silver'],
      ['16', '3', 'insert', '4', 'di', 'silver'],
      ['17', '1', 'update_preimage', '2', 'bob', 'bronze'],
      ['17', '1', 'update_postimage', '2', 'bob', 'gold'],
      ['18', '3', 'delete', '4', 'di', 'silver'],
    ]);
    // The kind of every row is a class and a mark that does not depend on color: + inserted, ← before, → after, − deleted.
    expect(grid.kinds).toEqual([
      'insert',
      'insert',
      'insert',
      'insert',
      'update-before',
      'update-after',
      'delete',
    ]);
    expect(grid.marks).toEqual(['+', '+', '+', '+', '←', '→', '−']);
    // Only the cell that the update changed is marked, in both rows of the pair.
    expect(grid.changed).toEqual([[], [], [], [], [5], [5], []]);
    expect(grid.summary).toBe(
      '4 inserted, 1 updated, 1 deleted (6 changes) after @15 until @18 · @16 +4 · @17 ~1 · @18 −1',
    );
    // The order of the changes must not be disturbed: no sorting and no filter.
    expect([grid.sorters, grid.filters]).toEqual([0, 0]);
    expect(grid.status).toMatch(/^7 rows · /);
    await t.shot('show-changes');
  });

  await t.step(
    'Show Rows Changed from the leaf of a snapshot opens the changes of exactly that snapshot',
    async () => {
      await collapseNode(page, 'shop');
      await expandNode(page, 'Snapshots');
      await scrollToRow(page, '@17');
      await expandNode(page, '@17');
      // An update is an insert and a delete in one snapshot: two leaves of the same table.
      const leaves = treeRow(page, 'shop.customers', { level: 4 });
      await expect(leaves).toHaveCount(2);
      expect(await leaves.locator('.label-description').allTextContents()).toEqual([
        'Inserted into table',
        'Deleted from table',
      ]);
      const leaf = leaves.first();
      // The leaf of a table has the one command.
      expect(await contextMenuItems(page, leaf)).toEqual(['Show Rows Changed', 'Script as']);
      await chooseFromContextMenu(page, leaf, 'Show Rows Changed');

      await expect(changesTab(page, `shop.customers changes @16 → @17 · ${LAKE}`)).toBeVisible();
      await expect.poll(async () => (await readGrid(page)).rows.length).toBe(2);
      const grid = await readGrid(page);
      expect(grid.rows.map((row) => row.map((cell) => cell.text))).toEqual([
        ['17', '1', 'update_preimage', '2', 'bob', 'bronze'],
        ['17', '1', 'update_postimage', '2', 'bob', 'gold'],
      ]);
      expect(grid.kinds).toEqual(['update-before', 'update-after']);
      expect(grid.summary).toBe('1 updated (1 change) after @16 until @17 · @17 ~1');
      expect(await tabTitles()).toContain(`shop.customers changes @16 → @17 · ${LAKE}`);
      await t.shot('show-rows-changed');
    },
  );
}
