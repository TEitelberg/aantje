import assert from 'node:assert/strict';
import { readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { isAdvisorMessage } from '../../src/advisor/protocol';
import type { AdvisorMessage } from '../../src/advisor/protocol';
import type { ExtensionApi } from '../../src/extension';
import type { CatalogTree } from '../../src/tree/model';
import { HISTORY_ID, HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import {
  copyHistoryDataFixture,
  observeWebviews,
  requireEngine,
  runOnCatalog,
  useExtensionCache,
} from './data';
import type { DataFixture, WebviewRecord } from './data';
import { Desktop } from './desktop';
import { activate, assertDryRunFirst, nodeAt, onTeardownAsync, setConnections, waitFor } from './support';

/** The Advisor data that the extension posted to a page. */
const sentTo = (record: WebviewRecord): AdvisorMessage[] => record.messages.filter(isAdvisorMessage);

/** What the page does when a button is pressed: it posts the request to the extension. */
async function post(record: WebviewRecord, request: unknown): Promise<void> {
  assert.ok(record.receivers.length > 0, 'the extension listens to the page');
  for (const receiver of record.receivers) {
    await receiver(request);
  }
}

const untitledDocuments = (): vscode.TextDocument[] =>
  vscode.workspace.textDocuments.filter((document) => document.isUntitled);

const tabsOf = (viewType: string): string[] =>
  vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType))
    .map((tab) => tab.label);

const stamp = (days: number): string =>
  `strftime((now() - INTERVAL ${days} DAY) AT TIME ZONE 'UTC', '%Y-%m-%d %H:%M:%S.%f') || '+00'`;

/** Every file below a directory with its size: equal before and after means that nothing was written or deleted. */
function listing(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => `${path}:${statSync(path).size}`)
    .sort();
}

describe('the Maintenance Advisor', function () {
  before(async function () {
    await requireEngine(this);
  });

  let api: ExtensionApi;
  let tree: CatalogTree;
  let desktop: Desktop;
  let webviews: WebviewRecord[];
  let fixture: DataFixture;

  beforeEach(async () => {
    api = await activate();
    ({ tree } = api);
    desktop = Desktop.install();
    webviews = observeWebviews();
    await useExtensionCache();
    onTeardownAsync(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });

  afterEach(() => {
    desktop.assertDone();
  });

  /**
   * A private copy of the history lake in which every snapshot but the newest is 40 days old and the five files that wait
   * for the cleanup have waited for 10 days, so that no clock changes what the dry runs list.
   */
  async function useHistory(): Promise<void> {
    fixture = await copyHistoryDataFixture('sqlite');
    await runOnCatalog(
      fixture,
      `UPDATE meta.ducklake_files_scheduled_for_deletion SET schedule_start = ${stamp(10)}`,
      `UPDATE meta.ducklake_snapshot SET snapshot_time = ${stamp(40)} WHERE snapshot_id < (SELECT max(snapshot_id) FROM meta.ducklake_snapshot)`,
    );
    await setConnections([fixture.profile]);
    await vscode.commands.executeCommand('aantje.connect', await lake());
  }

  const lake = () => nodeAt(tree, fixture.profile.name);
  const advisors = () => webviews.filter(({ viewType }) => viewType === 'aantje.advisor');
  const dataDirectory = () => join(fixture.directory, 'sqlite-files');

  /** Opens the panel of the connection and waits for the page to ask for and get its data. */
  async function open(): Promise<WebviewRecord> {
    await vscode.commands.executeCommand('aantje.showAdvisor', await lake());
    const panel = await waitFor('the advisor panel', () => advisors().at(-1));
    await waitFor('the advisor page to ask for its data and get it', () => sentTo(panel).length > 0, 60_000);
    return panel;
  }

  /** Posts the request and returns the SQL document it opened. */
  async function opensDocument(panel: WebviewRecord, request: unknown): Promise<vscode.TextDocument> {
    const before = new Set(untitledDocuments());
    await post(panel, request);
    await waitFor('the document', () => untitledDocuments().some((document) => !before.has(document)));
    const document = untitledDocuments().find((candidate) => !before.has(candidate));
    assert.ok(document);
    onTeardownAsync(async () => {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });
    return document;
  }

  it('opens a panel and sends what the dry runs found on the history lake, and changes nothing', async () => {
    await useHistory();
    const files = listing(fixture.directory);
    const documents = untitledDocuments().length;

    const panel = await open();

    assert.equal(tabsOf('aantje.advisor').length, 1);
    assert.equal(untitledDocuments().length, documents, 'no document was opened');
    const [message] = sentTo(panel);
    const data = message?.data ?? assert.fail('no data');
    assert.equal(data.connection, 'History lake (sqlite)');
    assert.equal(data.snapshot, HISTORY_LATEST_SNAPSHOT);
    assert.equal(data.expiry.state, 'measured');
    assert.deepEqual(
      data.expiry.state === 'measured' ? [data.expiry.value.snapshots, data.expiry.value.expiring] : [],
      [57, 56],
    );
    assert.deepEqual(data.cleanup, { state: 'measured', value: { files: 5, bytes: 2067, sized: 5 } });
    assert.deepEqual(data.orphans, { state: 'measured', value: { files: 0, bytes: 0, sized: 0 } });
    assert.deepEqual(
      data.merge.map(({ table, files, smallFiles, estimatedAfter }) => [
        table.name,
        files,
        smallFiles,
        estimatedAfter,
      ]),
      [['events', 9, 9, 1]],
    );
    assert.deepEqual(
      data.rewrite.map(({ table, deleted, records, atThreshold }) => [
        table.name,
        deleted,
        records,
        atThreshold,
      ]),
      [['customers', 2, 4, 0]],
    );
    assert.deepEqual(data.flush, []);
    assert.deepEqual(listing(fixture.directory), files, 'no file was written or deleted');
    const [scheduled] = await runOnCatalog(
      fixture,
      'SELECT count(*) FROM meta.ducklake_files_scheduled_for_deletion',
    );
    assert.equal(Number(scheduled?.[0]), 5, 'the files that wait for the cleanup are still scheduled');
    assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
  });

  it('measures the newest snapshot although the tree shows an older one', async () => {
    await useHistory();
    tree.selectSnapshot(fixture.profile.id, 24);

    const panel = await open();

    const data = sentTo(panel)[0]?.data ?? assert.fail('no data');
    assert.equal(data.snapshot, HISTORY_LATEST_SNAPSHOT);
    assert.deepEqual(data.cleanup, { state: 'measured', value: { files: 5, bytes: 2067, sized: 5 } });
    assert.equal(tree.state(fixture.profile.id).snapshot, 24, 'the tree keeps its snapshot');
  });

  it('measures again on Refresh: a file that appeared in the data path since is an orphan now', async () => {
    await useHistory();
    const panel = await open();
    assert.deepEqual(sentTo(panel)[0]?.data.orphans, {
      state: 'measured',
      value: { files: 0, bytes: 0, sized: 0 },
    });
    const stray = join(dataDirectory(), 'stray.parquet');
    writeFileSync(stray, 'x'.repeat(321));
    const old = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(stray, old, old);

    await post(panel, { type: 'refresh' });

    await waitFor('the second data', () => sentTo(panel).length === 2, 60_000);
    const orphans = sentTo(panel)[1]?.data.orphans;
    assert.deepEqual(orphans, { state: 'measured', value: { files: 1, bytes: 321, sized: 1 } });
    assert.equal(advisors().length, 1);
  });

  describe('the actions of a recommendation', () => {
    it('open the script of the lake with the dry run active and the real call commented out, and the script of the table the advisor named, and run nothing', async () => {
      await useHistory();
      const panel = await open();

      for (const [action, procedure] of [
        ['scriptExpire', 'ducklake_expire_snapshots'],
        ['scriptCleanup', 'ducklake_cleanup_old_files'],
        ['scriptOrphans', 'ducklake_delete_orphaned_files'],
      ] as const) {
        const document = await opensDocument(panel, { type: 'action', action });

        assert.equal(document.languageId, 'sql');
        assertDryRunFirst(document.getText(), procedure);
        const key = document.uri.toString();
        await waitFor(
          'the document to belong to the connection',
          () => api.editors.connectionOf(key) === fixture.profile.id,
        );
        assert.deepEqual(
          [api.editors.state(key)?.running, api.editors.state(key)?.sessionOpen],
          [false, false],
        );
      }

      for (const [action, table, call] of [
        [
          'scriptMerge',
          HISTORY_ID.events,
          "CALL ducklake_merge_adjacent_files('lake', 'events', schema => 'shop');",
        ],
        [
          'scriptRewrite',
          HISTORY_ID.customers,
          "CALL ducklake_rewrite_data_files('lake', 'customers', schema => 'shop');",
        ],
      ] as const) {
        const document = await opensDocument(panel, { type: 'action', action, table });

        assert.deepEqual(
          document
            .getText()
            .split('\n')
            .filter((line) => line.startsWith('CALL ')),
          [call],
        );
      }
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('Show table in tree selects the table, and Show Statistics opens the statistics report at the snapshot of the report', async () => {
      await useHistory();
      const panel = await open();

      await post(panel, { type: 'action', action: 'revealTable', table: HISTORY_ID.events });
      await waitFor('the table to be selected', () =>
        api.view.selection.some((node) => node.ref.kind === 'table'),
      );
      const [node] = api.view.selection;
      assert.deepEqual(
        [node?.ref.kind, node?.ref.kind === 'table' ? node.ref.table.name : undefined],
        ['table', 'events'],
      );

      await post(panel, { type: 'action', action: 'showStatistics', table: HISTORY_ID.events });
      await waitFor('the statistics report', () =>
        webviews.some(({ viewType }) => viewType === 'aantje.statistics'),
      );
      assert.ok(
        webviews
          .find(({ viewType }) => viewType === 'aantje.statistics')
          ?.title.includes(`@${HISTORY_LATEST_SNAPSHOT}`),
        'the statistics are those of the snapshot of the report',
      );
    });

    it('Show Storage Report and Check Health open the panels of those reports for the connection', async () => {
      await useHistory();
      const panel = await open();

      await post(panel, { type: 'action', action: 'showStorage' });
      await post(panel, { type: 'action', action: 'checkHealth' });

      await waitFor(
        'both panels',
        () =>
          ['aantje.storage', 'aantje.health'].every((type) =>
            webviews.some(({ viewType }) => viewType === type),
          ),
        60_000,
      );
      await waitFor('the tab of the storage report', () => tabsOf('aantje.storage').length > 0);
    });

    it('ignores a table the advisor did not name for that script, an action nobody declared and a command id', async () => {
      await useHistory();
      const panel = await open();
      const documents = untitledDocuments().length;
      const panels = webviews.length;

      for (const request of [
        { type: 'action', action: 'scriptMerge', table: 9999 },
        { type: 'action', action: 'scriptRewrite', table: HISTORY_ID.events },
        { type: 'action', action: 'scriptFlush', table: HISTORY_ID.events },
        { type: 'action', action: 'aantje.checkHealth' },
        { type: 'action', action: 'scriptExpire', sql: 'DROP TABLE x' },
        { type: 'markdown', view: { filter: 'x' } },
      ]) {
        await post(panel, request);
      }

      assert.equal(untitledDocuments().length, documents);
      assert.equal(webviews.length, panels);
    });
  });

  it('opens a Markdown document with the numbers the panel shows', async () => {
    await useHistory();
    const panel = await open();
    const before = new Set(untitledDocuments());

    await post(panel, { type: 'markdown' });

    await waitFor('the document', () => untitledDocuments().some((document) => !before.has(document)));
    const document = untitledDocuments().find((candidate) => !before.has(candidate));
    onTeardownAsync(async () => {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });
    assert.equal(document?.languageId, 'markdown');
    const text = document?.getText() ?? '';
    // The name of the connection is shown literally: Markdown would read the brackets.
    assert.match(text, /^# Maintenance advisor of History lake \\\(sqlite\\\)\n/);
    assert.match(text, /\| Snapshots to expire \| 56 of 57, older than 30 days \|/);
    assert.match(text, /\| Files to clean up \| 5 files, 2 KB \|/);
  });
});
