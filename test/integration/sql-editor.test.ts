import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { ResultsRunState } from '../../src/grid/results-model';
import { silentLogger } from '../../src/log';
import { revealStatement } from '../../src/sql/editor.vscode';
import type { ResultsTarget, ResultsView, RunSummary } from '../../src/sql/results';
import type { SqlEvent } from '../../src/sql/session';
import type { CatalogTree } from '../../src/tree/model';
import { copyDataFixture, observeWebviews, requireEngine, setSetting, useExtensionCache } from './data';
import type { DataFixture } from './data';
import { Desktop, pick } from './desktop';
import {
  activate,
  copyFixture,
  extension,
  nodeAt,
  onTeardown,
  onTeardownAsync,
  outline,
  setConnections,
  statusBar,
  uniqueId,
  waitFor,
} from './support';

const ORDERS_SELECT = `SELECT
  "id",
  "customer",
  "attrs",
  "amount",
  "created"
FROM "sales"."orders"
LIMIT 1000;`;
const BIG_ORDERS_SELECT = `SELECT *
FROM "sales"."big_orders"
LIMIT 1000;`;
const LONG_QUERY = 'SELECT count(*) FROM range(100000000000)';
const READ_ONLY_TEXT =
  'This is a read-only session: the statement would change the lake. Run "Toggle Read-only Session" to switch this editor to a read-write session.';

interface Manifest {
  readonly contributes: {
    readonly commands: readonly { command: string; title: string; category?: string }[];
    readonly keybindings: readonly { command: string; key: string; mac?: string; when: string }[];
    readonly menus: Record<
      string,
      readonly { command?: string; submenu?: string; when?: string; group?: string }[]
    >;
    readonly configuration: { readonly properties: Record<string, { default?: unknown }> };
  };
}
const manifest = (): Manifest => extension().packageJSON as Manifest;

/** Stands in for the results panel: records what the editor hands over. */
class FakeResults implements ResultsView {
  readonly begun: string[] = [];
  readonly events: SqlEvent[] = [];
  readonly ends: RunSummary[] = [];
  readonly revealed: ResultsTarget[] = [];
  /** The titles that the panels would get, one per run. */
  readonly titles: string[] = [];

  begin(target: ResultsTarget, script: { text: string }): void {
    this.titles.push(target.title);
    this.begun.push(script.text);
  }

  event(_target: ResultsTarget, event: SqlEvent): void {
    this.events.push(event);
  }

  end(_target: ResultsTarget, summary: RunSummary): void {
    this.ends.push(summary);
  }

  reveal(target: ResultsTarget): void {
    this.revealed.push(target);
  }

  /** The result sets of the runs so far, as rows. */
  get rows(): unknown[][][] {
    return this.events.flatMap((event) => (event.kind === 'resultSet' ? [event.rows as unknown[][]] : []));
  }

  get errors(): string[] {
    return this.events.flatMap((event) => (event.kind === 'error' ? [event.message] : []));
  }
}

describe('the SQL editor', function () {
  this.timeout(120_000);

  before(async function () {
    await requireEngine(this);
  });

  let api: ExtensionApi;
  let tree: CatalogTree;
  let desktop: Desktop;
  let results: FakeResults;
  /** The results panels of the extension, which the fake stands in for. */
  let panels: ResultsView;

  beforeEach(async () => {
    api = await activate();
    ({ tree } = api);
    desktop = Desktop.install();
    results = new FakeResults();
    const original = api.results.current;
    panels = original;
    api.results.current = results;
    onTeardown(() => {
      api.results.current = original;
    });
    await useExtensionCache();
  });

  afterEach(() => {
    desktop.assertDone();
  });

  const keyOf = (document: vscode.TextDocument): string => document.uri.toString();

  /** Closes a document after the test, without the question whether to save it, and waits until its session is gone. */
  function closeAfterTest(document: vscode.TextDocument): void {
    onTeardownAsync(async () => {
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await waitFor(
        'the editor to forget the document',
        () => api.editors.connectionOf(keyOf(document)) === undefined,
      );
    });
  }

  /** The untitled document that a command opened; it is closed after the test. */
  async function newQuery(...path: string[]): Promise<vscode.TextDocument> {
    const before = new Set(vscode.workspace.textDocuments.filter((document) => document.isUntitled));
    await vscode.commands.executeCommand('aantje.newQuery', await nodeAt(tree, ...path));
    const document = vscode.workspace.textDocuments.find((d) => d.isUntitled && !before.has(d));
    assert.ok(document, 'New Query opened a document');
    closeAfterTest(document);
    return document;
  }

  async function setText(document: vscode.TextDocument, text: string): Promise<vscode.TextEditor> {
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit((edit) => {
      edit.setEndOfLine(vscode.EndOfLine.LF);
      edit.replace(new vscode.Range(0, 0, document.lineCount, 0), text);
    });
    return editor;
  }

  /** Runs the command on the active editor and waits until the run has ended. */
  async function run(command = 'aantje.runQuery'): Promise<RunSummary> {
    const ended = results.ends.length;
    await vscode.commands.executeCommand(command);
    await waitFor('the run to end', () => results.ends.length > ended);
    const summary = results.ends[ended];
    assert.ok(summary);
    return summary;
  }

  async function dataLake(
    kind: 'sqlite' | 'duckdb',
    extra: { readOnly?: boolean } = {},
  ): Promise<DataFixture> {
    const fixture = await copyDataFixture(kind);
    await setConnections([{ ...fixture.profile, ...extra }]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, fixture.profile.name));
    return fixture;
  }

  describe('declaration', () => {
    it('declares the commands in the category aantje and shows the palette entries only where they apply', () => {
      const { commands, menus } = manifest().contributes;
      const ids = [
        'aantje.newQuery',
        'aantje.selectQueryConnection',
        'aantje.runQuery',
        'aantje.runStatement',
        'aantje.cancelQuery',
        'aantje.toggleReadOnly',
        'aantje.queryMenu',
      ];
      assert.deepEqual(
        commands
          .filter(({ command }) => ids.includes(command))
          .map(({ command, category }) => [command, category]),
        ids.map((id) => [id, 'aantje']),
      );
      const palette = new Map((menus.commandPalette ?? []).map(({ command, when }) => [command, when]));
      assert.equal(palette.has('aantje.newQuery'), false, 'New Query is always in the palette');
      assert.deepEqual(
        ids.slice(1).map((id) => palette.get(id)),
        [
          'editorLangId == sql',
          'editorLangId == sql',
          'editorLangId == sql',
          'aantje.queryEditor && aantje.queryRunning',
          'aantje.queryEditor',
          'aantje.queryEditor',
        ],
      );
    });

    it('binds F5, Ctrl+Enter, Shift+F5 and the results toggle only in SQL editors that belong to a connection', () => {
      const { keybindings } = manifest().contributes;
      assert.deepEqual(
        keybindings.map(({ command, key, mac }) => [command, key, mac]),
        [
          ['aantje.runQuery', 'f5', undefined],
          ['aantje.runStatement', 'ctrl+enter', 'cmd+enter'],
          ['aantje.cancelQuery', 'shift+f5', undefined],
          ['aantje.toggleResults', 'ctrl+alt+r', undefined],
        ],
      );
      for (const { when } of keybindings) {
        assert.ok(when.includes('editorTextFocus && editorLangId == sql && aantje.queryEditor'), when);
      }
      assert.ok(keybindings[2]?.when.endsWith('aantje.queryRunning'));
      assert.ok(keybindings[3]?.when.endsWith('aantje.queryHasResults'));
    });

    it('puts Run or Cancel and Hide or Show Results in the title of the editor', () => {
      assert.deepEqual(manifest().contributes.menus['editor/title'], [
        {
          command: 'aantje.runQuery',
          when: 'aantje.queryEditor && !aantje.queryRunning',
          group: 'navigation@1',
        },
        {
          command: 'aantje.cancelQuery',
          when: 'aantje.queryEditor && aantje.queryRunning',
          group: 'navigation@1',
        },
        {
          command: 'aantje.hideResults',
          when: 'aantje.queryEditor && aantje.queryHasResults && !aantje.queryResultsCollapsed',
          group: 'navigation@2',
        },
        {
          command: 'aantje.showResults',
          when: 'aantje.queryEditor && aantje.queryResultsCollapsed',
          group: 'navigation@2',
        },
      ]);
    });

    it('declares the setting for the largest result and gives the connections a read-only switch', () => {
      const { properties } = manifest().contributes.configuration;
      assert.equal(properties['aantje.sql.maxRows']?.default, 10_000);
      const items = (properties['aantje.connections'] as unknown as { items: { properties: object } }).items;
      assert.ok('readOnly' in items.properties);
    });
  });

  describe('New Query', () => {
    let id: string;

    beforeEach(async () => {
      id = uniqueId('query');
      await setConnections([{ id, name: id, kind: 'sqlite', path: copyFixture('ducklake.sqlite') }]);
      await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, id));
    });

    it('opens an untitled SQL document with the Script as SELECT text for a table, and for a view', async () => {
      const table = await newQuery(id, 'sales', 'Tables', 'orders');
      const view = await newQuery(id, 'sales', 'Views', 'big_orders');

      for (const [document, text] of [
        [table, ORDERS_SELECT],
        [view, BIG_ORDERS_SELECT],
      ] as const) {
        assert.equal(document.languageId, 'sql');
        assert.ok(document.isUntitled);
        assert.equal(document.getText(), text);
        assert.equal(api.editors.connectionOf(keyOf(document)), id, 'the document belongs to the connection');
      }
      assert.equal(vscode.window.activeTextEditor?.document, view, 'the new document is shown');
    });

    it('opens an empty document for a connection and for a schema, and does not copy the DDL', async () => {
      const connection = await newQuery(id);
      const schema = await newQuery(id, 'sales');

      assert.equal(connection.getText(), '');
      assert.equal(schema.getText(), '');
      assert.equal(api.editors.connectionOf(keyOf(connection)), id);
      assert.equal(api.editors.connectionOf(keyOf(schema)), id);
      assert.deepEqual(desktop.copied, []);
    });

    it('shows the connection and its mode in the status bar while the document is active, and hides it for others', async () => {
      const document = await newQuery(id);
      assert.deepEqual(
        { visible: statusBar('aantje.queryStatus').visible, text: statusBar('aantje.queryStatus').text },
        { visible: true, text: `$(database) ${id} · read/write` },
      );
      assert.equal(statusBar('aantje.queryStatus').command, 'aantje.queryMenu');

      const other = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT 1' });
      closeAfterTest(other);
      await vscode.window.showTextDocument(other);
      await waitFor('the status item to hide', () => !statusBar('aantje.queryStatus').visible);

      await vscode.window.showTextDocument(document);
      await waitFor('the status item to show', () => statusBar('aantje.queryStatus').visible);
    });

    it('asks which connection from the palette when there are several, and takes the only one without asking', async () => {
      const second = uniqueId('second');
      await setConnections([
        { id, name: id, kind: 'sqlite', path: copyFixture('ducklake.sqlite') },
        { id: second, name: second, kind: 'sqlite', path: copyFixture('ducklake.sqlite') },
      ]);
      desktop.answer(pick(second));
      await vscode.commands.executeCommand('aantje.newQuery');
      const [asked] = desktop.picks;
      assert.deepEqual(
        asked?.rows.map(({ label }) => label),
        [id, second],
      );
      const document = vscode.window.activeTextEditor?.document;
      assert.ok(document);
      closeAfterTest(document);
      assert.equal(api.editors.connectionOf(keyOf(document)), second);

      await setConnections([{ id, name: id, kind: 'sqlite', path: copyFixture('ducklake.sqlite') }]);
      await vscode.commands.executeCommand('aantje.newQuery');
      assert.equal(desktop.picks.length, 1, 'no second question');
      const next = vscode.window.activeTextEditor?.document;
      assert.ok(next);
      closeAfterTest(next);
      assert.equal(api.editors.connectionOf(keyOf(next)), id);
    });

    it('offers New Query on a connected connection, a schema, a table and a view', () => {
      const entry = (manifest().contributes.menus['view/item/context'] ?? []).find(
        ({ command }) => command === 'aantje.newQuery',
      );
      assert.deepEqual(entry, {
        command: 'aantje.newQuery',
        when: 'view == aantje.catalogs && viewItem =~ /^(connection\\.connected(\\.azure)?|schema(\\.main)?|table(\\.azure)?|view(\\.azure)?)$/',
        group: '2_query@1',
      });
    });
  });

  describe('running SQL', () => {
    it('creates and fills a table, and the explorer shows it after the run, without any refresh by the user', async () => {
      const fixture = await dataLake('sqlite');
      const { name } = fixture.profile;
      const document = await newQuery(name, 'sales');
      await setText(
        document,
        'CREATE TABLE sales.made (a INTEGER);\nINSERT INTO sales.made VALUES (1), (2);',
      );
      const before = await outline(tree, await nodeAt(tree, name));
      assert.ok(!before.some((line) => line.includes('made')));
      const latest = tree.state(fixture.profile.id).latestSnapshot;

      const summary = await run();

      assert.deepEqual(
        { failed: summary.failed, cancelled: summary.cancelled },
        { failed: false, cancelled: false },
      );
      assert.deepEqual(
        results.events
          .filter((event) => event.kind === 'message')
          .map((event) => event.kind === 'message' && event.text),
        ['Commands completed successfully.', '2 rows affected.'],
      );
      await waitFor('the tree to show the new table', async () =>
        (await outline(tree, await nodeAt(tree, name))).some((line) => line.startsWith('      made')),
      );
      assert.ok(
        (tree.state(fixture.profile.id).latestSnapshot ?? 0) > (latest ?? 0),
        'the explorer sees the new snapshots',
      );
      assert.deepEqual(results.begun, [
        'CREATE TABLE sales.made (a INTEGER);\nINSERT INTO sales.made VALUES (1), (2);',
      ]);
      assert.equal(results.revealed.length, 1);
    });

    it('selects with the Run Query command, reads the rows back and keeps one session for the editor', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      await setText(document, 'SELECT id FROM sales.orders ORDER BY id');

      await run();
      await run();

      assert.deepEqual(results.rows, [
        [[1], [3]],
        [[1], [3]],
      ]);
      assert.deepEqual(
        desktop.progress.map((title) => title),
        Array(2).fill(`Running SQL on ${fixture.profile.name}...`),
      );
      assert.equal(api.editors.state(keyOf(document))?.sessionOpen, true);
    });

    it('runs the selection only when there is one, and the statement at the cursor with Run Statement at Cursor', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      const editor = await setText(document, 'SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT 3 AS c;');

      editor.selection = new vscode.Selection(new vscode.Position(1, 3), new vscode.Position(1, 3));
      await run('aantje.runStatement');
      editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 14));
      await run('aantje.runQuery');
      editor.selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 0));
      await run('aantje.runQuery');

      assert.deepEqual(results.begun, [
        'SELECT 2 AS b',
        'SELECT 1 AS a;',
        'SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT 3 AS c;',
      ]);
      assert.deepEqual(results.rows, [[[2]], [[1]], [[1]], [[2]], [[3]]]);
    });

    it('selects the statement in the editor when the panel asks for it, whatever part of the document ran', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      const editor = await setText(document, 'SELECT 1;\nSELECT * FROM nope;');
      editor.selection = new vscode.Selection(new vscode.Position(1, 3), new vscode.Position(1, 3));
      await run('aantje.runStatement');
      assert.equal(results.errors.length, 1);
      assert.ok(results.errors[0]?.includes('nope'));

      // The statement ran as a script of its own: offset 0 of it is the start of line 2.
      revealStatement(api.editors, keyOf(document), 0, 6, silentLogger);

      await waitFor('the statement to be selected', () => {
        const { selection } = vscode.window.activeTextEditor ?? {};
        return (
          selection?.start.line === 1 && selection.start.character === 0 && selection.end.character === 6
        );
      });
    });

    it('refuses a write in a read-only session with the friendly message, and shows the mode in the status bar', async () => {
      const fixture = await dataLake('sqlite', { readOnly: true });
      const document = await newQuery(fixture.profile.name, 'sales');
      await setText(document, 'INSERT INTO sales.orders (id) VALUES (9)');

      const summary = await run();

      assert.equal(summary.failed, true);
      assert.deepEqual(results.errors, [READ_ONLY_TEXT]);
      assert.equal(statusBar('aantje.queryStatus').text, `$(database) ${fixture.profile.name} · read-only`);
    });

    it('switches this editor to a writable session with Toggle Read-only Session, and the profile stays as it is', async () => {
      const fixture = await dataLake('sqlite', { readOnly: true });
      const document = await newQuery(fixture.profile.name, 'sales');
      await setText(document, 'INSERT INTO sales.orders (id) VALUES (9)');
      await run();

      await vscode.commands.executeCommand('aantje.toggleReadOnly');
      assert.equal(statusBar('aantje.queryStatus').text, `$(database) ${fixture.profile.name} · read/write`);
      await run();

      assert.deepEqual(results.errors, [READ_ONLY_TEXT]);
      assert.ok(
        results.events.some((event) => event.kind === 'message' && event.text === '1 row affected.'),
        'the second run wrote',
      );
      const stored = vscode.workspace.getConfiguration('aantje').get<{ readOnly?: boolean }[]>('connections');
      assert.equal(stored?.[0]?.readOnly, true);
    });

    it('cancels a running query with Cancel Query and with the second run refused meanwhile', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      await setText(document, LONG_QUERY);
      const running = Promise.resolve(vscode.commands.executeCommand('aantje.runQuery'));
      await waitFor('the statement to start', () => results.events.some((event) => event.kind === 'start'));
      assert.equal(api.editors.state(keyOf(document))?.running, true);

      await vscode.commands.executeCommand('aantje.runQuery');
      assert.deepEqual(desktop.infos, ['A query is already running in this editor.']);
      await vscode.commands.executeCommand('aantje.cancelQuery');
      await running;

      assert.equal(results.ends.length, 1);
      assert.equal(results.ends[0]?.cancelled, true);
      assert.deepEqual(results.errors, ['The statement was cancelled.']);
      assert.equal(api.editors.state(keyOf(document))?.running, false);
    });

    it('shows an open transaction in the status bar, and rolls it back when the document closes, with a message', async () => {
      const fixture = await dataLake('sqlite');
      const name = `${uniqueId('rollback')}.sql`;
      const uri = vscode.Uri.parse(`untitled:${name}`);
      const document = await vscode.languages.setTextDocumentLanguage(
        await vscode.workspace.openTextDocument(uri),
        'sql',
      );
      await setText(document, 'BEGIN;\nINSERT INTO sales.orders (id) VALUES (9);');
      desktop.answer(pick(fixture.profile.name));
      await vscode.commands.executeCommand('aantje.selectQueryConnection');
      assert.equal(api.editors.connectionOf(keyOf(document)), fixture.profile.id);

      await run();
      assert.equal(
        statusBar('aantje.queryStatus').text,
        `$(database) ${fixture.profile.name} · read/write · transaction open`,
      );
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await waitFor(
        'the editor to forget the document',
        () => api.editors.connectionOf(keyOf(document)) === undefined,
      );

      assert.deepEqual(desktop.infos, [`Rolled back the open transaction of ${name}`]);
      // The same document opens again without a connection and with a session that starts fresh: nothing was committed.
      const again = await vscode.workspace.openTextDocument(uri);
      closeAfterTest(again);
      assert.equal(again.getText(), '');
      assert.equal(api.editors.connectionOf(keyOf(again)), undefined);
      const check = await newQuery(fixture.profile.name, 'sales');
      await setText(check, 'SELECT count(*)::INTEGER FROM sales.orders');
      await run();
      assert.deepEqual(results.rows, [[[2]]]);
    });

    it('asks for a connection first when a run is requested for a document without one, then runs', async () => {
      const fixture = await dataLake('sqlite');
      const document = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT 5' });
      closeAfterTest(document);
      await vscode.window.showTextDocument(document);
      desktop.answer(pick(fixture.profile.name));

      await run();

      assert.deepEqual(
        desktop.picks.map(({ title, rows }) => [title, rows.map(({ label }) => label)]),
        [['Select Connection for Query', [fixture.profile.name]]],
      );
      assert.equal(api.editors.connectionOf(keyOf(document)), fixture.profile.id);
      assert.deepEqual(results.rows, [[[5]]]);
    });

    it('cuts a result at the setting aantje.sql.maxRows', async () => {
      const fixture = await dataLake('sqlite');
      await setSetting('sql.maxRows', 2);
      const document = await newQuery(fixture.profile.name, 'sales');
      await setText(document, 'SELECT * FROM range(10)');

      await run();

      const [result] = results.events.filter((event) => event.kind === 'resultSet');
      assert.ok(result?.kind === 'resultSet' && result.truncated && result.rows.length === 2);
    });
  });

  describe('a DuckDB file catalog', () => {
    it('is let go by the explorer when a writable session opens, and connected again when the session turns read-only', async () => {
      const fixture = await dataLake('duckdb');
      const { id, name } = fixture.profile;
      const document = await newQuery(name, 'sales');
      await setText(document, 'SELECT 1');
      assert.equal(tree.state(id).status, 'connected');

      await run();

      assert.equal(tree.state(id).status, 'disconnected');
      assert.deepEqual(desktop.infos, [
        `Disconnected the explorer from ${name} while the editor has it open for writing.`,
      ]);

      await vscode.commands.executeCommand('aantje.toggleReadOnly');
      await waitFor('the explorer to connect again', () => tree.state(id).status === 'connected');
      await run();
      assert.deepEqual(results.rows, [[[1]], [[1]]]);
      assert.equal(tree.state(id).status, 'connected', 'a read-only session shares the file');
    });

    it('keeps the explorer connected for a profile with a read-only session', async () => {
      const fixture = await dataLake('duckdb', { readOnly: true });
      const document = await newQuery(fixture.profile.name, 'sales');
      await setText(document, 'SELECT count(*)::INTEGER FROM sales.orders');

      await run();

      assert.deepEqual(results.rows, [[[2]]]);
      assert.equal(tree.state(fixture.profile.id).status, 'connected');
      assert.deepEqual(desktop.infos, []);
    });
  });

  describe('IntelliSense', () => {
    const complete = async (document: vscode.TextDocument, offset: number): Promise<string[]> => {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        document.positionAt(offset),
      );
      // The words of the open documents come from the editor itself, as items of the kind Text.
      return list.items
        .filter(({ kind }) => kind !== vscode.CompletionItemKind.Text)
        .map(({ label }) => (typeof label === 'string' ? label : label.label));
    };

    it('completes the tables of the catalog and the keywords in a document of a connection, and nothing in another one', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      await setText(document, 'SELECT * FROM sales.');
      const unrelated = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: 'SELECT * FROM sales.',
      });
      closeAfterTest(unrelated);

      const tables = await complete(document, document.getText().length);
      assert.ok(tables.includes('orders'), tables.join(', '));
      assert.ok(tables.includes('big_orders'));

      await setText(document, 'SEL');
      assert.ok((await complete(document, 3)).includes('SELECT'));
      assert.deepEqual(await complete(unrelated, unrelated.getText().length), []);
      await setText(unrelated, 'SEL');
      assert.deepEqual(await complete(unrelated, 3), []);
    });

    it('still completes keywords while the explorer is not connected', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      await tree.disconnect(fixture.profile.id);
      await setText(document, 'SEL');

      assert.ok((await complete(document, 3)).includes('SELECT'));
    });

    it('completes the newest snapshot whatever the tree shows, the snapshot of AT (VERSION => n), and inserts snippets', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      // sales.tmp exists at snapshot 10 and was dropped at 11.
      tree.selectSnapshot(fixture.profile.id, 10);
      await setText(document, 'SELECT * FROM sales.');
      assert.ok(!(await complete(document, 20)).includes('tmp'));
      await setText(document, 'SELECT * FROM sales. AT (VERSION => 10)');
      assert.ok((await complete(document, 20)).includes('tmp'));

      await setText(document, 'SELECT * FROM sales.orders ');
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        document.positionAt(document.getText().length),
      );
      const snippet = list.items.find(({ kind }) => kind === vscode.CompletionItemKind.Snippet);
      assert.ok(snippet?.insertText instanceof vscode.SnippetString);
      assert.equal(snippet.insertText.value, 'AT (VERSION => ${1})');
    });

    it('connects the explorer to a connection when a document gets it, so that completion has the catalog', async () => {
      const fixture = await copyDataFixture('sqlite');
      await setConnections([fixture.profile]);
      assert.equal(tree.state(fixture.profile.id).status, 'disconnected');
      const document = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT 1' });
      closeAfterTest(document);
      await vscode.window.showTextDocument(document);
      desktop.answer(pick(fixture.profile.name));

      await vscode.commands.executeCommand('aantje.selectQueryConnection');

      await waitFor('the explorer to connect', () => tree.state(fixture.profile.id).status === 'connected');
    });

    it('marks a syntax error in a document of a connection and in no other', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      const unrelated = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELEC 1' });
      closeAfterTest(unrelated);
      await setText(document, 'SELEC 1');

      const marks = await waitFor('the syntax error', () => {
        const found = vscode.languages.getDiagnostics(document.uri);
        return found.length > 0 ? found : undefined;
      });

      assert.equal(marks[0]?.source, 'aantje');
      assert.equal(marks[0]?.severity, vscode.DiagnosticSeverity.Error);
      assert.deepEqual(vscode.languages.getDiagnostics(unrelated.uri), []);
      await setText(document, 'SELECT 1');
      await waitFor('the mark to go', () => vscode.languages.getDiagnostics(document.uri).length === 0);
    });

    it('warns of a column that the table lacks, and its quick fix puts in the nearest name', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      await setText(document, 'SELECT amout FROM sales.orders');

      const [mark] = await waitFor('the warning', () => {
        const found = vscode.languages.getDiagnostics(document.uri);
        return found.length > 0 ? found : undefined;
      });
      assert.ok(mark);
      assert.equal(mark.severity, vscode.DiagnosticSeverity.Warning);
      assert.equal(document.getText(mark.range), 'amout');
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        document.uri,
        mark.range,
        vscode.CodeActionKind.QuickFix.value,
      );
      const [fix] = actions.filter(({ edit }) => edit !== undefined);
      assert.ok(fix?.edit);
      await vscode.workspace.applyEdit(fix.edit);
      assert.equal(document.getText(), 'SELECT amount FROM sales.orders');
      await waitFor('the warning to go', () => vscode.languages.getDiagnostics(document.uri).length === 0);
    });
  });

  describe('the context keys', () => {
    const queryEditor = (): boolean | undefined => api.contextKeys.get('aantje.queryEditor');
    const queryRunning = (): boolean | undefined => api.contextKeys.get('aantje.queryRunning');

    it('marks the active editor as a query editor when it is a SQL document with a connection, and not otherwise', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      await waitFor('the key of a query editor', () => queryEditor() === true);

      const unrelated = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT 1' });
      closeAfterTest(unrelated);
      await vscode.window.showTextDocument(unrelated);
      await waitFor('the key to go for a SQL document without a connection', () => queryEditor() === false);

      // The registry knows the URI, but the document is not SQL: the keys must stay off.
      const notes = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'notes' });
      closeAfterTest(notes);
      await api.editors.associate({ key: keyOf(notes), name: 'notes' }, fixture.profile.id);
      await vscode.window.showTextDocument(notes);
      // Associating tells the extension to read the active editor again, which is the notes by now.
      await api.editors.associate({ key: keyOf(unrelated), name: 'unrelated' }, fixture.profile.id);
      assert.equal(queryEditor(), false);

      await vscode.window.showTextDocument(document);
      await waitFor('the key to come back', () => queryEditor() === true);
    });

    it('sets the running key while a query runs in the active editor, and clears it when the run is over', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      await setText(document, LONG_QUERY);
      await waitFor('the running key to be off', () => queryRunning() === false);

      const running = Promise.resolve(vscode.commands.executeCommand('aantje.runQuery'));
      await waitFor('the running key to be on', () => queryRunning() === true);
      assert.equal(queryEditor(), true);
      await vscode.commands.executeCommand('aantje.cancelQuery');
      await running;

      await waitFor('the running key to go', () => queryRunning() === false);
    });

    it('marks the results of the active editor, which the title buttons and the key close and show again with the same run', async () => {
      api.results.current = panels;
      const webviews = observeWebviews();
      const hasResults = (): boolean | undefined => api.contextKeys.get('aantje.queryHasResults');
      const collapsed = (): boolean | undefined => api.contextKeys.get('aantje.queryResultsCollapsed');
      const resultsTabs = (): number =>
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .filter(
            ({ input }) =>
              input instanceof vscode.TabInputWebview && input.viewType.endsWith('aantje.results'),
          ).length;
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      await setText(document, 'SELECT id FROM sales.orders ORDER BY id');
      await waitFor('no results yet', () => hasResults() === false);

      await vscode.commands.executeCommand('aantje.runQuery');
      await waitFor('the results panel', () => resultsTabs() === 1);
      // The group below is made with the focus in it; the focus goes back to the query.
      await waitFor('the focus in the query', () => vscode.window.activeTextEditor?.document === document);
      await waitFor('the key of the results', () => hasResults() === true && collapsed() === false);

      await vscode.commands.executeCommand('aantje.toggleResults');
      await waitFor('the results to close', () => resultsTabs() === 0 && collapsed() === true);
      assert.equal(hasResults(), true);
      await vscode.commands.executeCommand('aantje.showResults');
      const again = await waitFor('a new panel', () => webviews[1]);
      const state = await waitFor(
        'the run on the new page',
        () =>
          again.messages.flatMap((message) => {
            const sent = message as { type?: string; state?: ResultsRunState };
            return sent.type === 'results-state' && sent.state ? [sent.state] : [];
          })[0],
      );
      assert.deepEqual(state.resultSets[0]?.rows, [[1], [3]]);
      assert.equal(collapsed(), false);
      await vscode.commands.executeCommand('aantje.hideResults');
      await waitFor('the results to close again', () => resultsTabs() === 0 && collapsed() === true);
    });
  });

  describe('the session menu in the status bar', () => {
    let fixture: DataFixture;
    let document: vscode.TextDocument;

    beforeEach(async () => {
      fixture = await dataLake('sqlite');
      document = await newQuery(fixture.profile.name, 'sales');
      await setText(document, 'SELECT 1');
    });

    const menuRows = (): string[] => desktop.picks.at(-1)?.rows.map(({ label }) => label) ?? [];

    it('is titled after the connection, offers what the state allows, and switches the mode with its entry', async () => {
      await run();
      desktop.answer(pick('Switch to a Read-only Session'));

      await vscode.commands.executeCommand('aantje.queryMenu');

      assert.equal(desktop.picks.at(-1)?.title, `SQL session of ${fixture.profile.name}`);
      assert.deepEqual(menuRows(), [
        'Select Connection...',
        'Switch to a Read-only Session',
        'Close Session',
      ]);
      assert.equal(statusBar('aantje.queryStatus').text, `$(database) ${fixture.profile.name} · read-only`);
      assert.equal(api.editors.state(keyOf(document))?.sessionOpen, false, 'the switch closed the session');
    });

    it('closes the session with Close Session and keeps the connection of the document', async () => {
      await run();
      desktop.answer(pick('Close Session'));

      await vscode.commands.executeCommand('aantje.queryMenu');

      assert.equal(api.editors.state(keyOf(document))?.sessionOpen, false);
      assert.equal(api.editors.connectionOf(keyOf(document)), fixture.profile.id);
    });

    it('cancels the query that runs with Cancel Query, and offers no Close Session meanwhile', async () => {
      await setText(document, LONG_QUERY);
      const running = Promise.resolve(vscode.commands.executeCommand('aantje.runQuery'));
      await waitFor('the statement to start', () => results.events.some((event) => event.kind === 'start'));
      desktop.answer(pick('Cancel Query'));

      await vscode.commands.executeCommand('aantje.queryMenu');
      await running;

      assert.deepEqual(menuRows(), ['Select Connection...', 'Switch to a Read-only Session', 'Cancel Query']);
      assert.equal(results.ends[0]?.cancelled, true);
    });

    it('moves the document to another connection with Select Connection', async () => {
      const other = { ...(await copyDataFixture('sqlite')).profile, name: 'Other lake' };
      await setConnections([fixture.profile, other]);
      desktop.answer(pick('Select Connection...'), pick(other.name));

      await vscode.commands.executeCommand('aantje.queryMenu');

      assert.equal(api.editors.connectionOf(keyOf(document)), other.id);
      assert.deepEqual(
        desktop.picks.map(({ title }) => title),
        [`SQL session of ${fixture.profile.name}`, 'Select Connection for Query'],
      );
      assert.deepEqual(desktop.picks[1]?.rows, [
        { label: fixture.profile.name, description: 'sqlite' },
        { label: other.name, description: 'sqlite' },
      ]);
    });

    it('changes nothing when the menu is dismissed', async () => {
      await run();
      desktop.answer(pick(undefined));

      await vscode.commands.executeCommand('aantje.queryMenu');

      assert.deepEqual(api.editors.state(keyOf(document)), {
        connectionId: fixture.profile.id,
        connectionName: fixture.profile.name,
        mode: 'read-write',
        running: false,
        sessionOpen: true,
        inTransaction: 'none',
        switchable: true,
      });
    });

    it('asks for a connection first when the document has none, as Select Connection does', async () => {
      const unrelated = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT 1' });
      closeAfterTest(unrelated);
      await vscode.window.showTextDocument(unrelated);
      desktop.answer(pick(fixture.profile.name));

      await vscode.commands.executeCommand('aantje.queryMenu');

      assert.deepEqual(
        desktop.picks.map(({ title }) => title),
        ['Select Connection for Query'],
      );
      assert.equal(api.editors.connectionOf(keyOf(unrelated)), fixture.profile.id);
    });
  });

  describe('the connection being edited', () => {
    it('closes the session and follows the new mode of the profile, after the settings changed', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      await setText(document, 'SELECT 1');
      await run();
      assert.equal(api.editors.state(keyOf(document))?.sessionOpen, true);

      await setConnections([{ ...fixture.profile, readOnly: true }]);

      await waitFor(
        'the session to be closed',
        () => api.editors.state(keyOf(document))?.sessionOpen === false,
      );
      assert.equal(api.editors.state(keyOf(document))?.mode, 'read-only');
      assert.equal(statusBar('aantje.queryStatus').text, `$(database) ${fixture.profile.name} · read-only`);
    });
  });

  describe('a writable session on a DuckDB file', () => {
    it('keeps the explorer disconnected when another document takes the connection', async () => {
      const fixture = await dataLake('duckdb');
      const { id, name } = fixture.profile;
      const first = await newQuery(name, 'sales');
      await setText(first, 'SELECT 1');
      await run();
      assert.equal(tree.state(id).status, 'disconnected');
      const connects: unknown[][] = [];
      const connect = tree.connect.bind(tree);
      Reflect.set(tree, 'connect', (...args: unknown[]) => {
        connects.push(args);
        return connect(...(args as [string]));
      });
      onTeardown(() => Reflect.deleteProperty(tree, 'connect'));
      const second = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT 2' });
      closeAfterTest(second);
      await vscode.window.showTextDocument(second);
      desktop.answer(pick(name));

      await vscode.commands.executeCommand('aantje.selectQueryConnection');

      assert.equal(api.editors.connectionOf(keyOf(second)), id);
      assert.deepEqual(connects, []);
      assert.equal(tree.state(id).status, 'disconnected');
    });
  });

  describe('the commands of the editor', () => {
    it('answers a command in a document that is not SQL, a document without a connection and an empty document', async () => {
      const fixture = await dataLake('sqlite');
      const notes = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'notes' });
      closeAfterTest(notes);
      await vscode.window.showTextDocument(notes);
      await vscode.commands.executeCommand('aantje.runQuery');
      assert.deepEqual(desktop.infos.splice(0), ['Open a SQL editor first.']);

      const unrelated = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT 1' });
      closeAfterTest(unrelated);
      await vscode.window.showTextDocument(unrelated);
      await vscode.commands.executeCommand('aantje.toggleReadOnly');
      assert.deepEqual(desktop.infos.splice(0), ['This editor has no connection yet. Select one first.']);

      await newQuery(fixture.profile.name);
      await vscode.commands.executeCommand('aantje.runStatement');
      assert.deepEqual(desktop.infos.splice(0), ['There is no statement at the cursor.']);
      assert.deepEqual(results.begun, []);
    });

    it('runs the statement where the cursor is, not where a selection started', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      const editor = await setText(document, 'SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT 3 AS c;');
      // The user selected backwards from the third line up to the first, so the cursor (active) is at the first.
      editor.selection = new vscode.Selection(new vscode.Position(2, 3), new vscode.Position(0, 3));
      await run('aantje.runStatement');
      // And forwards: the cursor is at the end, on the third line.
      editor.selection = new vscode.Selection(new vscode.Position(0, 3), new vscode.Position(2, 3));
      await run('aantje.runStatement');

      assert.deepEqual(results.begun, ['SELECT 1 AS a', 'SELECT 3 AS c']);
    });

    it('names the panel after the file of a document, not after its whole path', async () => {
      const fixture = await dataLake('sqlite');
      // An untitled document that has a path of folders, like the ones of a file that was not saved yet.
      const uri = vscode.Uri.parse(`untitled:/queries/${uniqueId('team')}/report.sql`);
      const document = await vscode.languages.setTextDocumentLanguage(
        await vscode.workspace.openTextDocument(uri),
        'sql',
      );
      closeAfterTest(document);
      await setText(document, 'SELECT 1');
      desktop.answer(pick(fixture.profile.name));

      await run();

      assert.deepEqual(results.titles, [`report.sql · ${fixture.profile.name}`]);
    });

    it('cancels from the progress notification, which has a Cancel button', async () => {
      const fixture = await dataLake('sqlite');
      const document = await newQuery(fixture.profile.name, 'sales');
      await setText(document, LONG_QUERY);
      const shown: vscode.ProgressOptions[] = [];
      const progress = { cancel: undefined as (() => void) | undefined };
      const window = vscode.window as unknown as Record<string, unknown>;
      const original = window.withProgress;
      window.withProgress = (
        options: vscode.ProgressOptions,
        task: (progress: vscode.Progress<object>, token: vscode.CancellationToken) => Thenable<unknown>,
      ) => {
        shown.push(options);
        const source = new vscode.CancellationTokenSource();
        progress.cancel = () => source.cancel();
        return task({ report: () => undefined }, source.token);
      };
      onTeardown(() => {
        window.withProgress = original;
      });
      const running = Promise.resolve(vscode.commands.executeCommand('aantje.runQuery'));
      await waitFor('the statement to start', () => results.events.some((event) => event.kind === 'start'));

      progress.cancel?.();
      await running;

      assert.deepEqual(
        shown.map(({ location, cancellable, title }) => [location, cancellable, title]),
        [[vscode.ProgressLocation.Notification, true, `Running SQL on ${fixture.profile.name}...`]],
      );
      assert.equal(results.ends[0]?.cancelled, true);
    });
  });
});
