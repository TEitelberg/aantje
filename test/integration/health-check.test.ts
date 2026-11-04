import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import { applyEvents } from '../../src/health-report/model';
import type { HealthData } from '../../src/health-report/model';
import { isHealthMessage, isWholeData } from '../../src/health-report/protocol';
import type { CatalogTree } from '../../src/tree/model';
import { HISTORY_ID, HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import {
  copyDataFixture,
  copyHistoryDataFixture,
  observeWebviews,
  requireEngine,
  runOnCatalog,
  setSetting,
  useExtensionCache,
} from './data';
import type { DataFixture, WebviewRecord } from './data';
import { Desktop, confirm } from './desktop';
import {
  activate,
  assertDryRunFirst,
  extension,
  nodeAt,
  onTeardown,
  onTeardownAsync,
  setConnections,
  waitFor,
} from './support';

interface Manifest {
  readonly contributes: {
    readonly commands: readonly { command: string; title: string; category?: string }[];
    readonly menus: Record<string, readonly { command?: string; when?: string; group?: string }[]>;
  };
}

const manifest = (): Manifest['contributes'] => (extension().packageJSON as Manifest).contributes;

/** What the health page has now: the whole state it was sent, with the batches of events since applied. */
function stateOf(record: WebviewRecord): HealthData | undefined {
  let data: HealthData | undefined;
  for (const message of record.messages) {
    if (isHealthMessage(message)) {
      data = isWholeData(message.data) ? message.data : data && applyEvents(data, message.data.events);
    }
  }
  return data;
}

const finishedState = (record: WebviewRecord): HealthData | undefined => {
  const data = stateOf(record);
  return data && data.status !== 'running' && data.status !== 'idle' ? data : undefined;
};

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

/** An S3 endpoint that says the bucket does not exist, or never answers (a store that hangs). */
function startStore(mode: 'no-bucket' | 'hang'): Promise<string> {
  const server = createServer((_request, response) => {
    if (mode === 'hang') {
      return;
    }
    response.writeHead(404, { 'content-type': 'application/xml' });
    response.end(
      '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>',
    );
  });
  onTeardown(() => {
    server.closeAllConnections();
    server.close();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

describe('the Health check', function () {
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

  /** A private copy of the history lake whose files wait for the cleanup only since a moment, so that no clock can make them overdue. */
  async function useHistory(): Promise<void> {
    fixture = await copyHistoryDataFixture('sqlite');
    await runOnCatalog(
      fixture,
      "UPDATE meta.ducklake_files_scheduled_for_deletion SET schedule_start = strftime(now() AT TIME ZONE 'UTC', '%Y-%m-%d %H:%M:%S.%f') || '+00'",
    );
    await setConnections([fixture.profile]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, fixture.profile.name));
  }

  const lake = () => nodeAt(tree, fixture.profile.name);
  const table = (name: string) => nodeAt(tree, fixture.profile.name, 'shop', 'Tables', name);
  const healthPanels = () => webviews.filter(({ viewType }) => viewType === 'aantje.health');

  /** Runs a command, waits for the panel it opens and for its run to end. */
  async function check(
    command: string,
    node: Promise<unknown>,
  ): Promise<{ panel: WebviewRecord; data: HealthData }> {
    await vscode.commands.executeCommand(command, await node);
    const panel = await waitFor('the health panel', () => healthPanels().at(-1));
    const data = await waitFor('the check to end', () => finishedState(panel), 60_000);
    return { panel, data };
  }

  const ids = (data: HealthData): string[] => data.findings.map(({ id }) => id).toSorted();

  describe('the commands', () => {
    it('are Check Health on an open connection and a schema and Check Table Health on a table, in the Reports submenu and hidden from the Command Palette', () => {
      const { commands, menus } = manifest();
      assert.deepEqual(
        commands
          .filter(({ command }) => /^aantje\.check(Table)?Health$/.test(command))
          .map(({ command, category }) => [command, category]),
        [
          ['aantje.checkHealth', 'aantje'],
          ['aantje.checkTableHealth', 'aantje'],
        ],
      );
      for (const command of ['aantje.checkHealth', 'aantje.checkTableHealth']) {
        assert.ok(
          (menus.commandPalette ?? []).some((entry) => entry.command === command && entry.when === 'false'),
          `${command} is hidden from the Command Palette`,
        );
      }
      const reports = menus['aantje.reports'] ?? [];
      assert.deepEqual(
        reports
          .filter(({ command }) => /^aantje\.check(Table)?Health$/.test(command ?? ''))
          .map(({ command, when }) => `${command} ${when}`)
          .toSorted(),
        [
          'aantje.checkHealth viewItem =~ /^connection\\.connected(\\.azure)?$/',
          'aantje.checkHealth viewItem =~ /^schema(\\.main)?$/',
          'aantje.checkTableHealth viewItem == table',
        ],
      );
    });
  });

  describe('Check Health', () => {
    it('opens a panel for the connection and shows the healthy history lake: no error, no warning, the infos it has, and what was checked', async () => {
      await useHistory();

      const { panel, data } = await check('aantje.checkHealth', lake());

      assert.deepEqual(tabsOf('aantje.health'), ['Health · History lake (sqlite)']);
      assert.ok(panel.messages.every(isHealthMessage), 'the page accepts everything the extension posted');
      assert.deepEqual(
        { connection: data.connection, scope: data.scope, depth: data.depth, status: data.status },
        { connection: 'History lake (sqlite)', scope: { kind: 'lake' }, depth: 'quick', status: 'done' },
      );
      assert.equal(data.snapshot, HISTORY_LATEST_SNAPSHOT);
      assert.deepEqual(
        data.groups.map(({ group, state }) => [group, state]),
        [
          ['catalog', 'done'],
          ['connection', 'done'],
          ['storage', 'done'],
          ['deep', 'skipped'],
        ],
      );
      assert.equal(data.summary?.errors, 0);
      assert.equal(data.summary?.warnings, 0);
      assert.deepEqual(ids(data), ['catalog.cleanup-pending', 'catalog.small-files:table:3']);
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('starts at once with the quick depth, and shows the same panel again when the command is repeated', async () => {
      await useHistory();
      const { panel } = await check('aantje.checkHealth', lake());
      const runs = panel.messages.length;

      await vscode.commands.executeCommand('aantje.checkHealth', await lake());
      await waitFor('a second run to begin', () => panel.messages.length > runs);
      await waitFor(
        'it to end',
        () => finishedState(panel)?.status === 'done' && panel.messages.length > runs + 1,
      );

      assert.equal(healthPanels().length, 1, 'no second panel was created');
      assert.deepEqual(tabsOf('aantje.health'), ['Health · History lake (sqlite)']);
    });

    it('reports a Parquet file that is gone from the store as an error of its table, with the SQL to inspect it', async () => {
      await useHistory();
      const [row] = await runOnCatalog(
        fixture,
        `SELECT data_file_id, path FROM meta.ducklake_data_file WHERE table_id = ${HISTORY_ID.log} AND end_snapshot IS NULL ORDER BY data_file_id`,
      );
      assert.ok(row, 'shop.log has a current data file');
      const file = join(fixture.directory, 'sqlite-files', 'shop', 'log', String(row[1]));
      assert.ok(existsSync(file), file);
      rmSync(file);

      const { data } = await check('aantje.checkHealth', lake());

      const id = `storage.file-missing:data:${String(row[0])}`;
      assert.ok(ids(data).includes(id), `${id} among ${ids(data).join(', ')}`);
      const lost = data.findings.find((finding) => finding.id === id);
      assert.equal(lost?.severity, 'error');
      assert.deepEqual(lost?.scope, { kind: 'table', id: HISTORY_ID.log, schema: 'shop', name: 'log' });
      assert.ok(lost?.inspectSql?.includes('ducklake_data_file'));
      assert.equal(data.summary?.errors, 1);
    });

    it('runs deeper when the page asks for it, with the number of files it chose, and replaces the results of the last run', async () => {
      await useHistory();
      const { panel } = await check('aantje.checkHealth', lake());

      await post(panel, { type: 'action', action: 'run', depth: 'deep', deepFiles: 5 });
      const data = await waitFor(
        'the deep check to end',
        () => {
          const state = finishedState(panel);
          return state?.depth === 'deep' ? state : undefined;
        },
        60_000,
      );

      assert.deepEqual(
        data.groups.map(({ group, state }) => [group, state]),
        [
          ['catalog', 'done'],
          ['connection', 'done'],
          ['storage', 'done'],
          ['deep', 'done'],
        ],
      );
      const deep = data.groups.find(({ group }) => group === 'deep');
      assert.equal(deep?.truncated, true, 'the cap of five files was reached');
      assert.ok((deep?.notChecked ?? 0) > 0);
      assert.equal(data.deepFiles, 5);
      assert.equal(healthPanels().length, 1);
    });

    it('ignores a request that the page was not offered: a run with a number of files out of range, a finding it was not sent, a command id', async () => {
      await useHistory();
      const { panel } = await check('aantje.checkHealth', lake());
      const messages = panel.messages.length;
      const documents = untitledDocuments().length;

      for (const request of [
        { type: 'action', action: 'run', depth: 'deep', deepFiles: 0 },
        { type: 'action', action: 'run', depth: 'deep', deepFiles: 1_000_000 },
        { type: 'action', action: 'inspect', finding: 'made.up:1' },
        { type: 'action', action: 'workbench.action.openSettings', finding: 'x' },
        { type: 'action', action: 'cancel' },
      ]) {
        await post(panel, request);
      }

      assert.equal(panel.messages.length, messages, 'nothing was started');
      assert.equal(untitledDocuments().length, documents);
    });
  });

  describe('Check Table Health', () => {
    it('checks one table: the panel is titled with it and every finding is about it', async () => {
      await useHistory();

      const { data } = await check('aantje.checkTableHealth', table('events'));

      assert.deepEqual(tabsOf('aantje.health'), ['Health · History lake (sqlite) · shop.events']);
      assert.deepEqual(data.scope, { kind: 'table', id: HISTORY_ID.events, schema: 'shop', name: 'events' });
      assert.deepEqual(ids(data), ['catalog.small-files:table:3']);
      assert.ok(data.findings.every(({ scope }) => scope.kind === 'table' && scope.id === HISTORY_ID.events));
    });

    it('does nothing on a folder or a column, and says to connect first when the connection is closed', async () => {
      await useHistory();
      const events = await table('events');
      await tree.children(events);
      const folder = await nodeAt(tree, fixture.profile.name, 'shop', 'Tables', 'events', 'Statistics');

      await vscode.commands.executeCommand('aantje.checkTableHealth', folder);
      await vscode.commands.executeCommand(
        'aantje.checkTableHealth',
        await nodeAt(tree, fixture.profile.name, 'shop'),
      );
      assert.deepEqual(webviews, []);

      await tree.disconnect(fixture.profile.id);
      await vscode.commands.executeCommand('aantje.checkHealth', await lake());
      assert.deepEqual(desktop.infos, ['Connect to a catalog first to check its health.']);
      assert.deepEqual(webviews, []);
    });
  });

  describe('the actions of a finding', () => {
    it('open the SQL of the finding in a new SQL document of the connection, with the text of the finding and nothing run', async () => {
      await useHistory();
      const { panel, data } = await check('aantje.checkHealth', lake());
      const finding = data.findings.find(({ id }) => id === 'catalog.cleanup-pending');
      assert.ok(finding?.inspectSql);
      const before = new Set(untitledDocuments());

      await post(panel, { type: 'action', action: 'inspect', finding: finding.id });

      await waitFor('the document', () => untitledDocuments().some((document) => !before.has(document)));
      const document = untitledDocuments().find((candidate) => !before.has(candidate));
      assert.ok(document);
      assert.equal(document.languageId, 'sql');
      assert.equal(document.getText(), finding.inspectSql);
      await waitFor(
        'the document to belong to the connection',
        () => api.editors.connectionOf(document.uri.toString()) === fixture.profile.id,
      );
    });

    it('open the maintenance script that answers the finding, as written for the table or the lake, and run nothing', async () => {
      await useHistory();
      const { panel } = await check('aantje.checkHealth', lake());

      const open = async (finding: string): Promise<vscode.TextDocument> => {
        const before = new Set(untitledDocuments());
        await post(panel, { type: 'action', action: 'script', finding });
        await waitFor('the document', () => untitledDocuments().some((document) => !before.has(document)));
        const document = untitledDocuments().find((candidate) => !before.has(candidate));
        assert.ok(document);
        return document;
      };

      const cleanup = await open('catalog.cleanup-pending');
      assertDryRunFirst(cleanup.getText(), 'ducklake_cleanup_old_files');
      await waitFor(
        'the script to belong to the connection',
        () => api.editors.connectionOf(cleanup.uri.toString()) === fixture.profile.id,
      );

      const merge = await open('catalog.small-files:table:3');
      assert.match(
        merge.getText(),
        /CALL ducklake_merge_adjacent_files\('lake', 'events', schema => 'shop'\);/,
      );
    });

    it('select the table of the finding in the tree and show its statistics', async () => {
      await useHistory();
      const { panel } = await check('aantje.checkHealth', lake());

      await post(panel, { type: 'action', action: 'revealTable', finding: 'catalog.small-files:table:3' });
      await waitFor('the table to be selected', () => api.view.selection[0]?.label === 'events');

      await post(panel, { type: 'action', action: 'showStatistics', finding: 'catalog.small-files:table:3' });
      await waitFor('the statistics panel', () => tabsOf('aantje.statistics').length > 0);
    });
  });

  describe('a lake that lost a Parquet file on the local disk', () => {
    it('offers Check Table Health in the error of Select Top 1000 Rows and, pressed, opens the panel of that table with the finding of the lost file', async () => {
      await useHistory();
      const [row] = await runOnCatalog(
        fixture,
        `SELECT data_file_id, path FROM meta.ducklake_data_file WHERE table_id = ${HISTORY_ID.log} AND end_snapshot IS NULL ORDER BY data_file_id`,
      );
      assert.ok(row, 'shop.log has a current data file');
      const file = join(fixture.directory, 'sqlite-files', 'shop', 'log', String(row[1]));
      rmSync(file);
      desktop.pressOnError('Check Table Health');

      await vscode.commands.executeCommand('aantje.previewTable', await table('log'));

      assert.equal(desktop.errors.length, 1);
      assert.match(
        desktop.errors[0] ?? '',
        /^Cannot read the data of "shop\.log": the catalog lists the data file .*, but it does not exist on this machine \((No such file or directory|The system cannot find the (file|path) specified)\)\. Likely causes: /s,
      );
      assert.ok((desktop.errors[0] ?? '').includes(String(row[1])), 'the message names the file');
      assert.doesNotMatch(desktop.errors[0] ?? '', /S3|aantje\.s3/);
      assert.deepEqual(desktop.errorActions, [['Check Table Health']]);
      const panel = await waitFor('the health panel', () => healthPanels().at(-1));
      const data = await waitFor('the check to end', () => finishedState(panel), 60_000);
      assert.deepEqual(tabsOf('aantje.health'), [`Health · ${fixture.profile.name} · shop.log`]);
      assert.equal(data.scope.kind, 'table');
      assert.equal(data.depth, 'quick');
      const lost = data.findings.find(({ id }) => id === `storage.file-missing:data:${String(row[0])}`);
      assert.equal(lost?.severity, 'error');
    });
  });

  describe('a lake whose store says that the bucket does not exist', () => {
    let endpoint: string;

    beforeEach(async () => {
      for (const variable of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
        const previous = process.env[variable];
        delete process.env[variable];
        onTeardown(() => {
          if (previous !== undefined) process.env[variable] = previous;
        });
      }
      endpoint = await startStore('no-bucket');
      await setSetting('s3.endpoint', endpoint);
      await setSetting('s3.urlStyle', 'path');
      fixture = await copyDataFixture('sqlite', () => 's3://aantje-test-bucket/lake/');
      await setConnections([fixture.profile]);
      await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, fixture.profile.name));
    });

    it('offers Check Table Health in the error of Select Top 1000 Rows and, pressed, opens the panel of that table with the quick check running', async () => {
      desktop.pressOnError('Check Table Health');

      await vscode.commands.executeCommand(
        'aantje.previewTable',
        await nodeAt(tree, fixture.profile.name, 'sales', 'Tables', 'orders'),
      );

      assert.equal(desktop.errors.length, 1);
      assert.match(desktop.errors[0] ?? '', /^Cannot read the data of "sales\.orders": .*HTTP 404/s);
      assert.deepEqual(desktop.errorActions, [['Check Table Health']]);
      const panel = await waitFor('the health panel', () => healthPanels().at(-1));
      const data = await waitFor('the check to end', () => finishedState(panel), 60_000);
      assert.deepEqual(tabsOf('aantje.health'), [`Health · ${fixture.profile.name} · sales.orders`]);
      assert.equal(data.scope.kind, 'table');
      assert.equal(data.depth, 'quick');
      assert.ok(ids(data).includes('connection.store-bucket-missing'), ids(data).join(', '));
      const bucket = data.findings.find(({ id }) => id === 'connection.store-bucket-missing');
      assert.equal(bucket?.severity, 'error');
      assert.equal(bucket?.settingKey, 's3.endpoint');
    });

    it('leaves the panel closed when the user does not press the button', async () => {
      await vscode.commands.executeCommand(
        'aantje.previewTable',
        await nodeAt(tree, fixture.profile.name, 'sales', 'Tables', 'orders'),
      );

      assert.equal(desktop.errors.length, 1);
      assert.deepEqual(desktop.errorActions, [['Check Table Health']]);
      assert.deepEqual(healthPanels(), []);
    });

    it('opens the setting of a finding in the settings editor, named with the prefix of the extension', async () => {
      const { panel, data } = await check('aantje.checkHealth', lake());
      assert.ok(data.findings.some(({ settingKey }) => settingKey === 's3.endpoint'));
      const finding = data.findings.find(({ id }) => id === 'connection.store-bucket-missing');
      assert.ok(finding);
      const opened: unknown[][] = [];
      const original = vscode.commands.executeCommand.bind(vscode.commands) as (
        command: string,
        ...args: unknown[]
      ) => Thenable<unknown>;
      assert.ok(
        Reflect.set(vscode.commands, 'executeCommand', (command: string, ...args: unknown[]) => {
          if (command === 'workbench.action.openSettings') {
            opened.push(args);
            return Promise.resolve(undefined);
          }
          return original(command, ...args);
        }),
      );
      onTeardown(() => {
        Reflect.set(vscode.commands, 'executeCommand', original);
      });

      await post(panel, { type: 'action', action: 'setting', finding: finding.id });

      await waitFor('the settings to open', () => opened.length > 0);
      assert.deepEqual(opened, [['aantje.s3.endpoint']]);
    });
  });

  describe('a lake on S3 whose endpoint is not set', () => {
    let store: string;
    const configured = (key: string) => vscode.workspace.getConfiguration('aantje').inspect(key)?.globalValue;

    beforeEach(async () => {
      // The environment of the extension host names the store; no endpoint and no keys are configured.
      for (const variable of [
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_ENDPOINT_URL',
        'AWS_ENDPOINT_URL_S3',
      ]) {
        const previous = process.env[variable];
        delete process.env[variable];
        onTeardown(() => {
          if (previous === undefined) delete process.env[variable];
          else process.env[variable] = previous;
        });
      }
      store = await startStore('no-bucket');
      process.env.AWS_ENDPOINT_URL_S3 = store;
      await setSetting('s3.endpoint', undefined);
      await setSetting('s3.urlStyle', undefined);
      // The request goes to AWS: whatever it answers, or if a firewall drops it, a short limit ends the wait.
      await setSetting('queryTimeoutSeconds', 8);
      fixture = await copyDataFixture('sqlite', () => 's3://aantje-test-bucket/lake/');
      await setConnections([fixture.profile]);
      await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, fixture.profile.name));
    });

    const sawStore = (record: WebviewRecord): HealthData | undefined => {
      const data = finishedState(record);
      return data?.findings.some(({ id }) => id === 'connection.store-bucket-missing') &&
        !data.findings.some(({ check }) => check === 'connection.endpoint-not-set')
        ? data
        : undefined;
    };

    it('reports the missing endpoint with the endpoint of the environment, next to the missing credentials', async () => {
      const { data } = await check('aantje.checkHealth', lake());

      const notSet = data.findings.find(({ id }) => id === 'connection.endpoint-not-set');
      assert.deepEqual(notSet?.suggestion, {
        endpoint: store,
        urlStyle: 'path',
        source: 'AWS_ENDPOINT_URL_S3',
      });
      assert.equal(notSet?.settingKey, 's3.endpoint');
      assert.ok(ids(data).includes('connection.credentials-missing'), ids(data).join(', '));
      assert.deepEqual(
        data.groups.map(({ group, state }) => [group, state]),
        [
          ['catalog', 'done'],
          ['connection', 'done'],
          ['storage', 'skipped'],
          ['deep', 'skipped'],
        ],
      );
    });

    it('writes the endpoint and the URL style into the machine settings after the user confirmed, and checks again against that store', async () => {
      const { panel } = await check('aantje.checkHealth', lake());
      desktop.answer(confirm(true));

      await post(panel, { type: 'action', action: 'useEndpoint', finding: 'connection.endpoint-not-set' });

      const data = await waitFor('the second run to see the store', () => sawStore(panel), 60_000);
      assert.equal(configured('s3.endpoint'), store);
      assert.equal(configured('s3.urlStyle'), 'path');
      assert.deepEqual(desktop.confirmations, [
        `Set aantje.s3.endpoint to "${store}" and aantje.s3.urlStyle to "path" in your user settings?`,
      ]);
      assert.deepEqual(desktop.confirmationActions, [['Write Settings']]);
      assert.match(desktop.confirmationDetails[0] ?? '', /AWS_ENDPOINT_URL_S3/);
      assert.ok(data.findings.some(({ id }) => id === 'connection.credentials-missing'));
      const machine = vscode.workspace.getConfiguration('aantje').inspect('s3.endpoint');
      assert.equal(machine?.workspaceValue, undefined, 'nothing went into the workspace settings');
      assert.equal(machine?.workspaceFolderValue, undefined);
    });

    it('writes nothing and does not check again when the user cancels the question', async () => {
      const { panel } = await check('aantje.checkHealth', lake());
      const messages = panel.messages.length;
      desktop.answer(confirm(false));

      await post(panel, { type: 'action', action: 'useEndpoint', finding: 'connection.endpoint-not-set' });

      await waitFor('the question', () => desktop.confirmations.length > 0);
      // Give a wrong write or run the time to show.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(desktop.confirmations.length, 1);
      assert.equal(configured('s3.endpoint'), undefined);
      assert.equal(configured('s3.urlStyle'), undefined);
      assert.equal(panel.messages.length, messages, 'no second run was started');
    });

    it('runs the command that sets the credentials, with no key in the request, and checks again', async () => {
      const { panel, data } = await check('aantje.checkHealth', lake());
      const finding = data.findings.find(({ id }) => id === 'connection.credentials-missing');
      assert.ok(finding);
      const commands: unknown[][] = [];
      const original = vscode.commands.executeCommand.bind(vscode.commands) as (
        command: string,
        ...args: unknown[]
      ) => Thenable<unknown>;
      assert.ok(
        Reflect.set(vscode.commands, 'executeCommand', (command: string, ...args: unknown[]) => {
          if (command === 'aantje.setS3Credentials') {
            commands.push(args);
            return Promise.resolve(undefined);
          }
          return original(command, ...args);
        }),
      );
      onTeardown(() => {
        Reflect.set(vscode.commands, 'executeCommand', original);
      });
      const messages = panel.messages.length;

      await post(panel, { type: 'action', action: 'setCredentials', finding: finding.id });

      await waitFor('the command', () => commands.length > 0);
      assert.deepEqual(commands, [[]]);
      await waitFor('the second run to begin', () => panel.messages.length > messages);
      await waitFor('the second run to end', () => finishedState(panel), 60_000);
    });

    it('ignores the actions for a finding that does not offer them', async () => {
      const { panel } = await check('aantje.checkHealth', lake());
      const messages = panel.messages.length;

      await post(panel, { type: 'action', action: 'useEndpoint', finding: 'connection.credentials-missing' });
      await post(panel, { type: 'action', action: 'setCredentials', finding: 'made.up:1' });

      assert.deepEqual(desktop.confirmations, []);
      assert.equal(configured('s3.endpoint'), undefined);
      assert.equal(panel.messages.length, messages);
    });
  });

  describe('a store that does not answer', () => {
    it('can be cancelled from the panel: the run ends as cancelled and keeps what it found, and the groups that did not run say so', async () => {
      const endpoint = await startStore('hang');
      await setSetting('s3.endpoint', endpoint);
      await setSetting('s3.urlStyle', 'path');
      fixture = await copyDataFixture('sqlite', () => 's3://aantje-test-bucket/lake/');
      await setConnections([fixture.profile]);
      await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, fixture.profile.name));

      await vscode.commands.executeCommand('aantje.checkHealth', await lake());
      const panel = await waitFor('the health panel', () => healthPanels().at(-1));
      await waitFor('the catalog group to be done', () =>
        stateOf(panel)?.groups.some(({ group, state }) => group === 'catalog' && state === 'done'),
      );
      assert.equal(stateOf(panel)?.status, 'running');

      await post(panel, { type: 'action', action: 'cancel' });

      const data = await waitFor('the run to end', () => finishedState(panel), 30_000);
      assert.equal(data.status, 'cancelled');
      assert.equal(data.summary?.cancelled, true);
      assert.deepEqual(
        data.groups.map(({ group, state }) => [group, state]),
        [
          ['catalog', 'done'],
          ['connection', 'skipped'],
          ['storage', 'skipped'],
          ['deep', 'skipped'],
        ],
      );
    });
  });
});
