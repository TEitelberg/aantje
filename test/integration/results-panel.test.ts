import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as vscode from 'vscode';
import type { GridDeps } from '../../src/grid/grid.vscode';
import type { ExtensionMessage } from '../../src/grid/protocol';
import { ResultsPanels } from '../../src/grid/results.vscode';
import type { ResultsRunState } from '../../src/grid/results-model';
import { parseLayout, resultsPlace } from '../../src/grid/results-place';
import type { ResultsTarget } from '../../src/sql/results';
import type { SqlEvent } from '../../src/sql/session';
import { observeWebviews } from './data';
import type { WebviewRecord } from './data';
import { extension, onTeardown, onTeardownAsync, tempDir, waitFor } from './support';

const SCRIPT = 'CREATE TABLE t (id INTEGER);\nSELECT id, name FROM t;\nSELECT * FROM nope';
const SELECT_AT = SCRIPT.indexOf('SELECT id');
const NOPE_AT = SCRIPT.indexOf('nope');
const SUMMARY = { cancelled: false, failed: true, elapsedMs: 80, inTransaction: 'none' } as const;

/** What a session yields for SCRIPT: DDL, a SELECT with a NULL, and a statement that fails with a position. */
const EVENTS: SqlEvent[] = [
  { kind: 'start', index: 0, statementType: 'CREATE', sql: 'CREATE TABLE t (id INTEGER)', offset: 0 },
  { kind: 'message', index: 0, text: 'Commands completed successfully.', elapsedMs: 3 },
  { kind: 'start', index: 1, statementType: 'SELECT', sql: 'SELECT id, name FROM t', offset: SELECT_AT },
  {
    kind: 'resultSet',
    index: 1,
    columns: [
      { name: 'id', type: 'INTEGER', kind: 'number' },
      { name: 'name', type: 'VARCHAR', kind: 'text' },
    ],
    rows: [
      [1, 'a'],
      [2, null],
    ],
    truncated: false,
    elapsedMs: 4,
  },
  {
    kind: 'start',
    index: 2,
    statementType: 'SELECT',
    sql: 'SELECT * FROM nope',
    offset: SCRIPT.indexOf('SELECT * FROM nope'),
  },
  {
    kind: 'error',
    index: 2,
    message: 'Catalog Error: Table with name nope does not exist!',
    position: { offset: NOPE_AT, length: 4 },
  },
];

const targetOf = (name: string): ResultsTarget => ({ key: `untitled:${name}`, title: `${name}.sql` });

/** The target of an open document, as the editor names it: the key is the URI of the document. */
const targetOfDocument = (document: vscode.TextDocument, name: string): ResultsTarget => ({
  key: document.uri.toString(),
  title: `${name}.sql`,
});

/**
 * A document of a file. An untitled document that was only opened gets a stray tab of its own in the active group some
 * time later, which moves what the tests count.
 */
const openFile = (name: string, content: string): Thenable<vscode.TextDocument> => {
  const file = join(tempDir(), name);
  writeFileSync(file, content);
  return vscode.workspace.openTextDocument(vscode.Uri.file(file));
};

const openSql = (content = SCRIPT): Thenable<vscode.TextDocument> => openFile('query.sql', content);

/** The view column of the tab group that holds the tab, found by its label. */
const columnOfTab = (label: string): vscode.ViewColumn | undefined =>
  vscode.window.tabGroups.all.find((group) => group.tabs.some((tab) => tab.label === label))?.viewColumn;

/** The view column of the tab group that holds the document. */
const columnOfDocument = (document: vscode.TextDocument): vscode.ViewColumn | undefined =>
  vscode.window.tabGroups.all.find((group) =>
    group.tabs.some(
      (tab) =>
        tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === document.uri.toString(),
    ),
  )?.viewColumn;

/** The tab list follows the focus a moment later. */
const expectActiveColumn = async (column: vscode.ViewColumn): Promise<void> => {
  await waitFor(
    `the group in column ${column} to be the active one`,
    () => vscode.window.tabGroups.activeTabGroup.viewColumn === column,
  );
};

/** The focus follows `showTextDocument` and the making of a group a moment later. */
const expectEditor = async (document: vscode.TextDocument): Promise<void> => {
  await waitFor(
    `the editor of ${document.uri.toString()} to be the active one`,
    () => vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString(),
  );
};

/** The labels of the tabs of the group in the view column. */
const tabsOfColumn = (column: vscode.ViewColumn): string[] | undefined =>
  vscode.window.tabGroups.all.find((group) => group.viewColumn === column)?.tabs.map((tab) => tab.label);

/** The top level of the layout of the editor groups: its direction (1: stacked) and how many groups it has. */
async function shapeNow(): Promise<{ orientation: number; groups: number }> {
  const layout = await vscode.commands.executeCommand<{ orientation: number; groups: unknown[] }>(
    'vscode.getEditorLayout',
  );
  return { orientation: layout.orientation, groups: layout.groups.length };
}

/** The messages that the page was sent, of one kind or all. */
const sent = (record: WebviewRecord, type?: string): ExtensionMessage[] =>
  (record.messages as ExtensionMessage[]).filter((message) => type === undefined || message.type === type);

const resultsTabs = (): string[] =>
  vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('aantje.results'),
    )
    .map((tab) => tab.label);

/** The tab list of the window follows the panels a moment later. */
async function expectTabs(expected: string[]): Promise<void> {
  await waitFor(`the tabs ${expected.join(', ')}`, () => isDeepStrictEqual(resultsTabs().sort(), expected));
}

describe('the results panel of the SQL editor', () => {
  let webviews: WebviewRecord[];
  let panels: ResultsPanels;
  let revealed: [string, number, number][];
  let clipboard: string[];
  let saved: [string, string][];
  /** What the pages posted to the extension: the listeners that the panel registered, to be called like the page does. */
  let fromPage: (index: number, message: unknown) => void;
  /** The targets that have a panel, and how many panels the runs made. */
  let open: Set<string>;
  let made: number;

  beforeEach(() => {
    webviews = observeWebviews();
    const listeners: ((message: unknown) => void)[] = [];
    const window = vscode.window as unknown as Record<string, unknown>;
    const create = vscode.window.createWebviewPanel as (...args: unknown[]) => vscode.WebviewPanel;
    window.createWebviewPanel = (...args: unknown[]) => {
      const panel = create.apply(vscode.window, args);
      const register = panel.webview.onDidReceiveMessage.bind(panel.webview) as (
        listener: (message: unknown) => void,
        ...rest: unknown[]
      ) => vscode.Disposable;
      (panel.webview as unknown as Record<string, unknown>).onDidReceiveMessage = (
        listener: (message: unknown) => void,
        ...rest: unknown[]
      ) => {
        listeners.push(listener);
        return register(listener, ...rest);
      };
      return panel;
    };
    onTeardown(() => {
      window.createWebviewPanel = create;
    });
    fromPage = (index, message) => listeners[index]?.(message);
    open = new Set();
    made = 0;
    revealed = [];
    clipboard = [];
    saved = [];
    const deps: GridDeps = {
      clipboard: { writeText: (text) => Promise.resolve(void clipboard.push(text)) },
      saveFile: (name, content) => Promise.resolve(void saved.push([name, content])),
    };
    panels = new ResultsPanels(
      extension().extensionUri,
      { revealStatement: (key, offset, length) => revealed.push([key, offset, length]) },
      deps,
    );
    onTeardown(() => panels.dispose());
    onTeardownAsync(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.action.editorLayoutSingle');
    });
  });

  /** Runs and waits for the panel of a target that is new: it is made when the group for it is. */
  async function run(target: ResultsTarget, events: readonly SqlEvent[] = EVENTS): Promise<void> {
    panels.begin(target, { text: SCRIPT, startedAt: Date.now() });
    for (const event of events) {
      panels.event(target, event);
    }
    panels.end(target, SUMMARY);
    if (!open.has(target.key)) {
      open.add(target.key);
      made += 1;
    }
    await waitFor('the panels', () => webviews.length === made);
  }

  const stateOf = (record: WebviewRecord, index = 0): ResultsRunState => {
    const message = sent(record, 'results-state')[index];
    assert.ok(message && message.type === 'results-state', 'the page was sent the state of the run');
    return message.state;
  };

  /** A panel on top of the results in their group, so that the results are hidden. */
  async function cover(results: WebviewRecord, preserveFocus = false): Promise<void> {
    const column = results.panel.viewColumn;
    assert.ok(column);
    vscode.window.createWebviewPanel('aantje.test-cover', 'cover', { viewColumn: column, preserveFocus }, {});
    await waitFor('the results panel to be covered', () => !results.panel.visible);
  }

  it('opens below the editor without taking the focus, titled after the document, and holds the real results page', async () => {
    const document = await openSql();
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const target = targetOfDocument(document, 'Query1');

    await run(target);

    const [results] = webviews;
    assert.ok(results);
    assert.equal(webviews.length, 1);
    assert.equal(results.viewType, 'aantje.results');
    await expectTabs(['Query1.sql · results']);
    await waitFor(
      'the panel to be placed below the editor',
      () => results.panel.viewColumn === vscode.ViewColumn.Two,
    );
    assert.deepEqual(await shapeNow(), { orientation: 1, groups: 2 });
    assert.equal(vscode.window.tabGroups.all.length, 2);
    assert.equal(results.panel.active, false, 'the panel does not take the focus');
    await expectEditor(document);
    await expectActiveColumn(vscode.ViewColumn.One);
    assert.equal(results.panel.webview.options.enableScripts, true);
    assert.equal(results.panel.options.retainContextWhenHidden ?? false, false);
    const roots = results.panel.webview.options.localResourceRoots ?? [];
    assert.deepEqual(
      roots.map((root) => root.fsPath),
      [vscode.Uri.joinPath(extension().extensionUri, 'dist').fsPath],
    );
  });

  describe('the group below the editor', () => {
    it('is reused by the results of another document of the same group: one panel per document, no group per run', async () => {
      const first = await openSql('SELECT 1');
      await vscode.window.showTextDocument(first, { viewColumn: vscode.ViewColumn.One, preview: false });
      const second = await openSql('SELECT 2');

      await run(targetOfDocument(first, 'First'));
      await vscode.window.showTextDocument(second, { viewColumn: vscode.ViewColumn.One, preview: false });
      await run(targetOfDocument(second, 'Second'));
      await expectEditor(second);
      await expectActiveColumn(vscode.ViewColumn.One);
      await vscode.window.showTextDocument(first, { viewColumn: vscode.ViewColumn.One, preview: false });
      await run(targetOfDocument(first, 'First'));

      assert.equal(webviews.length, 2);
      await expectTabs(['First.sql · results', 'Second.sql · results']);
      assert.equal(vscode.window.tabGroups.all.length, 2, 'one group below, not one per run');
      assert.deepEqual(await shapeNow(), { orientation: 1, groups: 2 });
      assert.equal(columnOfTab('First.sql · results'), vscode.ViewColumn.Two);
      assert.equal(columnOfTab('Second.sql · results'), vscode.ViewColumn.Two);
      await expectEditor(first);
      await expectActiveColumn(vscode.ViewColumn.One);
    });

    it('is the group that already lies below the editor in a stacked layout, whatever it holds', async () => {
      const document = await openSql();
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      const notes = await openFile('notes.md', '# notes');
      await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 1, groups: [{}, {}] });
      await vscode.window.showTextDocument(notes, { viewColumn: vscode.ViewColumn.Two, preserveFocus: true });
      await waitFor('the notes in the second group', () => tabsOfColumn(vscode.ViewColumn.Two)?.length === 1);

      await run(targetOfDocument(document, 'Query1'));

      await expectTabs(['Query1.sql · results']);
      assert.equal(vscode.window.tabGroups.all.length, 2, 'no third group');
      assert.deepEqual(tabsOfColumn(vscode.ViewColumn.Two)?.sort(), ['Query1.sql · results', 'notes.md']);
      assert.equal(columnOfDocument(notes), vscode.ViewColumn.Two);
      assert.deepEqual(await shapeNow(), { orientation: 1, groups: 2 });
      await expectEditor(document);
      await expectActiveColumn(vscode.ViewColumn.One);
    });

    it('is made below the group of the document only, when another group lies beside it', async () => {
      const left = await openFile('left.md', '# left');
      await vscode.window.showTextDocument(left, vscode.ViewColumn.One);
      const document = await openSql();
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Two);
      await waitFor('both groups', () => vscode.window.tabGroups.all.length === 2);

      await run(targetOfDocument(document, 'Query1'));

      await expectTabs(['Query1.sql · results']);
      assert.equal(vscode.window.tabGroups.all.length, 3);
      assert.equal(columnOfDocument(left), vscode.ViewColumn.One, 'the group on the left is left alone');
      assert.equal(columnOfDocument(document), vscode.ViewColumn.Two);
      assert.equal(
        columnOfTab('Query1.sql · results'),
        vscode.ViewColumn.Three,
        'under the group of the document',
      );
      assert.deepEqual(
        vscode.window.tabGroups.all.map((group) => group.tabs.length),
        [1, 1, 1],
      );
      await expectEditor(document);
      await expectActiveColumn(vscode.ViewColumn.Two);
    });

    it('is made for two documents that run in the same tick, each below its own group', async () => {
      const left = await openSql('SELECT 1');
      await vscode.window.showTextDocument(left, vscode.ViewColumn.One);
      const right = await openSql('SELECT 2');
      await vscode.window.showTextDocument(right, vscode.ViewColumn.Two);
      await waitFor('both groups', () => vscode.window.tabGroups.all.length === 2);

      await Promise.all([run(targetOfDocument(left, 'Left')), run(targetOfDocument(right, 'Right'))]);

      await expectTabs(['Left.sql · results', 'Right.sql · results']);
      await waitFor('four groups', () => vscode.window.tabGroups.all.length === 4);
      assert.equal(columnOfDocument(left), vscode.ViewColumn.One);
      assert.equal(columnOfTab('Left.sql · results'), vscode.ViewColumn.Two, 'under the left document');
      assert.equal(columnOfDocument(right), vscode.ViewColumn.Three);
      assert.equal(columnOfTab('Right.sql · results'), vscode.ViewColumn.Four, 'under the right document');
      assert.deepEqual(
        vscode.window.tabGroups.all.map((group) => group.tabs.length),
        [1, 1, 1, 1],
        'no group is left empty, no results tab sits beside an editor',
      );
    });

    it('closes the panel that is made after the extension was disposed', async () => {
      const document = await openSql();
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

      panels.begin(targetOfDocument(document, 'Query1'), { text: SCRIPT, startedAt: Date.now() });
      panels.dispose();

      const [results] = await waitFor('the panel that was made meanwhile', () =>
        webviews.length === 1 ? webviews : undefined,
      );
      assert.ok(results);
      await waitFor('the panel to be closed', () => {
        try {
          return typeof results.panel.visible !== 'boolean';
        } catch {
          return true; // a closed panel refuses every access
        }
      });
    });
  });

  describe('bound to its editor', () => {
    /** Whether the panel sits in the group right below the group of the document. */
    async function belowDocument(results: WebviewRecord, document: vscode.TextDocument): Promise<boolean> {
      const layout = parseLayout(await vscode.commands.executeCommand('vscode.getEditorLayout'));
      const column = columnOfDocument(document);
      const place = layout && column !== undefined ? resultsPlace(layout, column) : undefined;
      return place?.kind === 'column' && place.column === Number(results.panel.viewColumn);
    }

    /** A query in the first group with its results below it, and the page that has the run. */
    async function queryWithResults(name = 'Query1', content = SCRIPT) {
      const document = await openFile(`${name}.sql`, content);
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
      const target = targetOfDocument(document, name);
      await run(target);
      const results = webviews.at(-1);
      assert.ok(results);
      await waitFor('the panel below the query', () => belowDocument(results, document));
      await waitFor('the page', () => sent(results, 'results-state').length > 0);
      return { document, target, results };
    }

    const close = async (document: vscode.TextDocument): Promise<void> => {
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    };

    it('closes with its query and leaves no group behind', async () => {
      const { document } = await queryWithResults();

      await close(document);

      await expectTabs([]);
      await waitFor('no group left over', () => vscode.window.tabGroups.all.length === 1);
      assert.equal(vscode.window.tabGroups.all[0]?.tabs.length, 0);
    });

    it('follows the query into the group below, which then takes the files the user opens', async () => {
      const { document, results } = await queryWithResults();
      const states = sent(results, 'results-state').length;

      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      await vscode.commands.executeCommand('workbench.action.moveEditorToBelowGroup');

      await waitFor('the panel below the query again', () => belowDocument(results, document));
      assert.equal(vscode.window.tabGroups.all.length, 2);
      // The page is loaded again in its new group and gets the whole run.
      await waitFor('the page with the run', () => sent(results, 'results-state').length > states);
      assert.deepEqual(stateOf(results, sent(results, 'results-state').length - 1).resultSets[0]?.rows, [
        [1, 'a'],
        [2, null],
      ]);
      await expectEditor(document);
      const notes = await openFile('notes.md', '# notes');
      await vscode.window.showTextDocument(notes);
      assert.equal(
        columnOfDocument(notes),
        columnOfDocument(document),
        'the group of the query is not locked',
      );
    });

    it('follows the query into a group on the right, and leaves no group behind', async () => {
      const notes = await openFile('notes.md', '# notes');
      await vscode.window.showTextDocument(notes, vscode.ViewColumn.Two);
      const { document, results } = await queryWithResults();
      assert.equal(columnOfDocument(notes), vscode.ViewColumn.Three, 'the notes are on the right of both');

      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      await vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');

      await waitFor(
        'the query beside the notes',
        () => columnOfDocument(document) === columnOfDocument(notes),
      );
      await waitFor('the panel below the query again', () => belowDocument(results, document));
      await waitFor('the empty group to close', () => vscode.window.tabGroups.all.length === 2);
      assert.deepEqual(await shapeNow(), { orientation: 1, groups: 2 });
    });

    it('comes forward with its query when two queries share a group, and the focus stays in the query', async () => {
      const first = await queryWithResults('First', 'SELECT 1');
      const second = await queryWithResults('Second', 'SELECT 2');
      assert.equal(first.results.panel.viewColumn, second.results.panel.viewColumn);
      await waitFor('the results of the second query in front', () => !first.results.panel.visible);

      await vscode.window.showTextDocument(first.document, vscode.ViewColumn.One);
      await waitFor('the results of the first query in front', () => first.results.panel.visible);
      await vscode.window.showTextDocument(second.document, vscode.ViewColumn.One);
      await waitFor('the results of the second query in front', () => second.results.panel.visible);

      assert.equal(second.results.panel.active, false);
      await expectEditor(second.document);
      await expectActiveColumn(vscode.ViewColumn.One);
    });

    it('closes and shows the same run again on toggle; a run shows collapsed results again, and the query closes them for good', async () => {
      const { document, target } = await queryWithResults();

      panels.collapse(target.key, true);
      await expectTabs([]);
      await waitFor('the group below to close', () => vscode.window.tabGroups.all.length === 1);
      assert.equal(panels.isCollapsed(target.key), true);
      panels.collapse(target.key, false);

      const again = await waitFor('a new panel', () => webviews[1]);
      await waitFor('the page with the run', () => sent(again, 'results-state').length > 0);
      assert.deepEqual(stateOf(again).resultSets[0]?.rows, [
        [1, 'a'],
        [2, null],
      ]);
      await waitFor('the new panel below the query', () => belowDocument(again, document));
      await expectEditor(document);

      panels.collapse(target.key, true);
      await expectTabs([]);
      panels.begin(target, { text: 'SELECT 7', startedAt: Date.now() });
      panels.end(target, { ...SUMMARY, failed: false });
      await waitFor('the panel of the run', () => webviews[2]);
      await expectTabs(['Query1.sql · results']);

      panels.collapse(target.key, true);
      await expectTabs([]);
      await close(document);
      await waitFor('the query to close', () => columnOfDocument(document) === undefined);
      await waitFor('the collapsed results to be forgotten', () => !panels.isCollapsed(target.key));
    });

    it('locks the group that it makes, so that a file opened from there lands elsewhere', async () => {
      const { results } = await queryWithResults();
      results.panel.reveal(undefined, false);
      await expectActiveColumn(vscode.ViewColumn.Two);

      const notes = await openFile('notes.md', '# notes');
      await vscode.window.showTextDocument(notes);

      assert.notEqual(columnOfDocument(notes), vscode.ViewColumn.Two);
      assert.deepEqual(tabsOfColumn(vscode.ViewColumn.Two), ['Query1.sql · results']);
    });
  });

  it('gives every page a nonce of its own for its script and style, as the policy of the page names it', async () => {
    await run(targetOf('A'));
    await run(targetOf('B'));
    const [first, second] = webviews;
    assert.ok(first && second);

    const nonceOf = (html: string): string => {
      const found = /<script nonce="([^"]+)"/.exec(html)?.[1];
      assert.ok(found, 'the page loads its script with a nonce');
      return found;
    };
    const [one, two] = [first, second].map(({ panel }) => nonceOf(panel.webview.html));

    assert.notEqual(one, two, 'a nonce that repeats protects nothing');
    for (const [html, nonce] of [
      [first.panel.webview.html, one],
      [second.panel.webview.html, two],
    ] as const) {
      assert.ok((nonce ? Buffer.from(nonce, 'base64').length : 0) >= 16, 'at least 16 random bytes');
      assert.ok(html.includes(`script-src 'nonce-${nonce}'`) && html.includes(`style-src 'nonce-${nonce}'`));
      assert.ok(html.includes(`<style nonce="${nonce}">`));
    }
  });

  it('sends the whole run once when the page says ready, and the events of a second run in the same panel as they come', async () => {
    const target = targetOf('Query1');
    await run(target);
    const [results] = webviews;
    assert.ok(results);
    assert.deepEqual(results.messages, [], 'nothing is posted to a page that has not loaded yet');

    await waitFor('the page to ask for the run and get it', () => sent(results, 'results-state').length > 0);

    assert.deepEqual(
      sent(results).map((message) => message.type),
      ['results-state'],
    );
    const state = stateOf(results);
    assert.deepEqual(
      state.statements.map(({ index, status }) => ({ index, status })),
      [
        { index: 0, status: 'ok' },
        { index: 1, status: 'ok' },
        { index: 2, status: 'error' },
      ],
    );
    assert.deepEqual(state.resultSets, [
      {
        statement: 1,
        columns: [
          { name: 'id', type: 'INTEGER', kind: 'number' },
          { name: 'name', type: 'VARCHAR', kind: 'text' },
        ],
        rows: [
          [1, 'a'],
          [2, null],
        ],
        truncated: false,
        elapsedMs: 4,
      },
    ]);
    assert.deepEqual(state.end, SUMMARY);

    panels.begin({ ...target, title: 'Renamed.sql' }, { text: 'SELECT 1', startedAt: Date.now() });
    panels.event(target, EVENTS[2] as SqlEvent);
    panels.event(target, EVENTS[3] as SqlEvent);
    panels.end(target, { ...SUMMARY, failed: false });

    assert.equal(webviews.length, 1, 'no second panel was created');
    await expectTabs(['Renamed.sql · results']);
    assert.deepEqual(
      sent(results).map((message) => message.type),
      ['results-state', 'results-begin', 'results-event', 'results-event', 'results-end'],
    );
    assert.deepEqual(sent(results)[1], { type: 'results-begin', script: 'SELECT 1' });
    assert.deepEqual(sent(results)[2], { type: 'results-event', event: EVENTS[2] });
  });

  it('comes forward on reveal without taking the focus from the editor where the user types, and does nothing for an editor without a panel', async () => {
    const document = await openSql();
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const target = targetOfDocument(document, 'Query1');
    await run(target);
    const [results] = webviews;
    assert.ok(results);
    await waitFor(
      'the panel to be placed below the editor',
      () => results.panel.viewColumn === vscode.ViewColumn.Two,
    );
    await waitFor('the page', () => sent(results, 'results-state').length === 1);
    await cover(results, true);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const active: boolean[] = [];
    results.panel.onDidChangeViewState(({ webviewPanel }) => active.push(webviewPanel.active));

    panels.reveal(target);

    await waitFor('the results panel to come forward', () => results.panel.visible);
    assert.deepEqual(active.filter(Boolean), [], 'the panel did not become the active one');
    assert.equal(results.panel.active, false);
    assert.equal(vscode.window.activeTextEditor?.document, document, 'the focus stays in the editor');
    panels.reveal(targetOf('Unknown'));
    assert.equal(webviews.filter(({ viewType }) => viewType === 'aantje.results').length, 1);
  });

  it('shows the whole run again when the panel is hidden and shown again, with what happened while it was hidden', async () => {
    const target = targetOf('Query1');
    await run(target);
    const [results] = webviews;
    assert.ok(results);
    await waitFor('the page', () => sent(results, 'results-state').length === 1);
    await cover(results);
    const before = sent(results).length;

    panels.begin(target, { text: 'SELECT 7', startedAt: Date.now() });
    panels.event(target, { kind: 'start', index: 0, statementType: 'SELECT', sql: 'SELECT 7', offset: 0 });
    panels.event(target, {
      kind: 'resultSet',
      index: 0,
      columns: [{ name: '7', type: 'INTEGER', kind: 'number' }],
      rows: [[7]],
      truncated: false,
      elapsedMs: 1,
    });
    panels.end(target, { ...SUMMARY, failed: false });
    assert.equal(sent(results).length, before, 'nothing is posted to a page that is hidden');

    panels.reveal(target);
    await waitFor(
      'the page to be loaded again and sent the run',
      () => sent(results, 'results-state').length === 2,
    );

    const state = stateOf(results, 1);
    assert.equal(state.statements.length, 1);
    assert.equal(state.statements[0]?.sql, 'SELECT 7');
    assert.deepEqual(state.resultSets[0]?.rows, [[7]]);
    assert.deepEqual(state.end, { ...SUMMARY, failed: false });
    assert.deepEqual(
      sent(results)
        .slice(before)
        .map((message) => message.type),
      ['results-state'],
    );
  });

  it('forgets the run when the user closes the panel and its group: events in between are dropped, and the next run makes a new panel below the editor again', async () => {
    const document = await openSql();
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const target = targetOfDocument(document, 'Query1');
    await run(target);
    const [first] = webviews;
    assert.ok(first);
    assert.equal(vscode.window.tabGroups.all.length, 2);
    first.panel.dispose();
    open.delete(target.key);
    await expectTabs([]);
    await waitFor(
      'the group below to close with its last tab',
      () => vscode.window.tabGroups.all.length === 1,
    );

    panels.event(target, EVENTS[0] as SqlEvent);
    panels.end(target, SUMMARY);
    panels.reveal(target);
    assert.equal(webviews.length, 1);
    assert.deepEqual(resultsTabs(), []);

    await run(target);
    assert.equal(webviews.length, 2);
    await expectTabs(['Query1.sql · results']);
    assert.equal(columnOfTab('Query1.sql · results'), vscode.ViewColumn.Two);
    assert.deepEqual(await shapeNow(), { orientation: 1, groups: 2 });
    await expectEditor(document);
  });

  it('says so and forgets the entry when no panel can be made: nothing is rejected unhandled, and the next run makes the panel', async () => {
    const window = vscode.window as unknown as Record<string, unknown>;
    const create = vscode.window.createWebviewPanel as (...args: unknown[]) => vscode.WebviewPanel;
    const showError = window.showErrorMessage;
    let failing = true;
    window.createWebviewPanel = (...args: unknown[]) => {
      if (failing) throw new Error('no panel today');
      return create.apply(vscode.window, args);
    };
    const shown: string[] = [];
    window.showErrorMessage = (message: string) => {
      shown.push(message);
      return Promise.resolve(undefined);
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): number => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    onTeardown(() => {
      process.off('unhandledRejection', onUnhandled);
      window.createWebviewPanel = create;
      window.showErrorMessage = showError;
    });
    const document = await openSql();
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const target = targetOfDocument(document, 'Query1');

    panels.begin(target, { text: SCRIPT, startedAt: Date.now() });
    panels.end(target, SUMMARY);

    await waitFor('the failure to be shown', () => shown.length === 1);
    assert.ok(shown[0]?.includes('no panel today'), shown[0]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, []);

    failing = false;
    await run(target);
    await expectTabs(['Query1.sql · results']);
    assert.equal(shown.length, 1);
  });

  describe('what the page posts', () => {
    async function ready(): Promise<WebviewRecord> {
      await run(targetOf('Query1'));
      const [results] = webviews;
      assert.ok(results);
      await waitFor('the page', () => sent(results, 'results-state').length === 1);
      return results;
    }

    it('asks the editor to show the statement, at the error when there is one, and copies and exports through the extension', async () => {
      await ready();

      fromPage(0, { type: 'reveal', index: 2 });
      fromPage(0, { type: 'reveal', index: 1 });
      fromPage(0, { type: 'copy', text: '1\ta', what: 'row' });
      fromPage(0, { type: 'export', csv: 'id\r\n1\r\n', suggestedName: 'result-1.csv' });

      assert.deepEqual(revealed, [
        ['untitled:Query1', NOPE_AT, 4],
        ['untitled:Query1', SELECT_AT, 'SELECT id, name FROM t'.length],
      ]);
      await waitFor('the clipboard and the file', () => clipboard.length === 1 && saved.length === 1);
      assert.deepEqual(clipboard, ['1\ta']);
      assert.deepEqual(saved, [['result-1.csv', 'id\r\n1\r\n']]);
    });

    it('does not pass on what is not a request that the page can make', async () => {
      await ready();

      for (const message of [
        { type: 'reveal', index: 99 },
        { type: 'reveal', index: -1 },
        { type: 'reveal', index: '1' },
        { type: 'reveal' },
        { type: 'run', sql: 'DROP TABLE t' },
        { type: 'results-state' },
        null,
        'reveal',
      ]) {
        fromPage(0, message);
      }

      assert.deepEqual(revealed, []);
    });
  });
});
