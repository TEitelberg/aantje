import * as vscode from 'vscode';
import { messageOf } from '../errors';
import { createPanel } from '../shell/host.vscode';
import type { ResultsTarget, ResultsView } from '../sql/results';
import type { SqlEvent } from '../sql/session';
import { receiveFrom, transfer } from './grid.vscode';
import type { GridDeps } from './grid.vscode';
import type { ExtensionMessage, WebviewMessage } from './protocol';
import { ResultsRun } from './results';
import { decide } from './results-binding';
import type { BindingAction, BindingSnapshot } from './results-binding';
import type { ResultsRunSummary } from './results-model';
import { groupCount, parseLayout, resultsPlace } from './results-place';
import type { EditorLayout, ResultsPlace } from './results-place';
import { GRID_CSS } from './style';

interface ResultsHost {
  /** "Go to statement": the editor of the key shows the range of the script. */
  revealStatement(key: string, offset: number, length: number): void;
  /** "Open as New Query" of a statement that aantje built: a new editor on the same connection gets its text. */
  openQuery?(key: string): void;
  /** Sets a window context key for `when` clauses. */
  setContext?(key: string, value: boolean): void;
}

interface Entry {
  /** Absent while the group for it is made and while the results are collapsed; the run keeps what happens meanwhile. */
  panel?: vscode.WebviewPanel;
  /** The group of the editor that the panel was placed for; none when no editor was found. */
  editorGroup?: vscode.TabGroup;
  collapsed: boolean;
  title: string;
  readonly run: ResultsRun;
}

/** One user action fires a burst of events (a move closes a tab and opens one); they are decided on once. */
const FOLLOW_DELAY_MS = 100;
/** How long to wait for the groups that the extension sees to agree with the layout, in rounds of `SETTLE_ROUND_MS`. */
const SETTLE_ROUNDS = 20;
const SETTLE_ROUND_MS = 50;

const keysOfTab = ({ input }: vscode.Tab): string[] =>
  input instanceof vscode.TabInputText ? [input.uri.toString()] : [];

const isResultsTab = ({ input }: vscode.Tab): boolean =>
  input instanceof vscode.TabInputWebview && input.viewType.endsWith('aantje.results');

const groupInColumn = (column: number | undefined): vscode.TabGroup | undefined =>
  vscode.window.tabGroups.all.find((group) => group.viewColumn === column);

/** The editor of the document, the active one first. */
const editorOf = (key: string): vscode.TextEditor | undefined =>
  [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors].find(
    (candidate) => candidate?.document.uri.toString() === key,
  );

const documentOf = (key: string): vscode.TextDocument | undefined =>
  vscode.workspace.textDocuments.find((document) => document.uri.toString() === key);

const layoutNow = async (): Promise<EditorLayout | undefined> =>
  parseLayout(await vscode.commands.executeCommand('vscode.getEditorLayout'));

/**
 * The layout, once the groups that the extension sees agree with it: VS Code tells the extension late about a group
 * that it closed, and until then the columns of the groups are those of before. The groups of a floating window never
 * agree with the layout of the main window, so the wait is short.
 */
async function settledLayout(): Promise<EditorLayout | undefined> {
  for (let round = 1; ; round++) {
    const layout = await layoutNow();
    if (!layout || groupCount(layout) === vscode.window.tabGroups.all.length || round >= SETTLE_ROUNDS) {
      return layout;
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_ROUND_MS));
  }
}

const placeIn = (layout: EditorLayout | undefined, column: number): ResultsPlace | undefined =>
  layout && resultsPlace(layout, column);

/** Notes a step of placing the results that failed; the results stay usable. */
type Warn = (message: string) => void;

const shows = (group: vscode.TabGroup, document: vscode.TextDocument): boolean =>
  vscode.window.tabGroups.all.includes(group) &&
  group.tabs.some((tab) => keysOfTab(tab).includes(document.uri.toString()));

// `ViewColumn.Beside` follows a user setting, so the group below comes from the layout (`resultsPlace`); without one
// the editor's group is split down. That new group is locked, so that files the user opens do not land among the
// results; an editor that was moved into such a group makes it an editor group again. The focus ends in the editor,
// in the group above the new one: a panel that leaves its group behind empty closes it, which renumbers the columns.
// Nothing happens when the user closed the editor or its group meanwhile: focusing it would open the document again.
async function putBelow<T>(
  document: vscode.TextDocument,
  editorGroup: vscode.TabGroup,
  put: (column: vscode.ViewColumn) => T,
  warn: Warn,
): Promise<T | undefined> {
  const layout = await settledLayout();
  const editorColumn = editorGroup.viewColumn;
  const place = shows(editorGroup, document) ? placeIn(layout, editorColumn) : undefined;
  if (place?.kind !== 'below') {
    return place && put(place.column);
  }
  await vscode.window.showTextDocument(document, { viewColumn: editorColumn });
  if (vscode.window.tabGroups.activeTabGroup.tabs.some(isResultsTab)) {
    await vscode.commands.executeCommand('workbench.action.unlockEditorGroup');
  }
  await vscode.commands.executeCommand('workbench.action.newGroupBelow');
  await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
  const made = placeIn(await layoutNow(), editorColumn);
  const result = made?.kind === 'column' ? put(made.column) : undefined;
  try {
    await vscode.commands.executeCommand('workbench.action.focusAboveGroup');
  } catch (error) {
    // What `put` made stands where it belongs; only the focus stays below.
    warn(`The focus could not go back to the editor above the results: ${messageOf(error)}`);
  }
  return result;
}

/** Opens below the editor without taking the focus. A document that no group shows, or a layout that cannot be read or split, gets `Beside`. */
async function createBelow(
  key: string,
  create: (column: vscode.ViewColumn) => vscode.WebviewPanel,
  warn: Warn,
): Promise<{ panel: vscode.WebviewPanel; editorGroup?: vscode.TabGroup }> {
  const editor = editorOf(key);
  const editorGroup = groupInColumn(editor?.viewColumn);
  // The panel that was made, also when a later step failed: a second one would leave the first one behind.
  const made: { panel?: vscode.WebviewPanel } = {};
  try {
    if (editor && editorGroup) {
      await putBelow(editor.document, editorGroup, (column) => (made.panel = create(column)), warn);
    }
  } catch (error) {
    warn(`The results panel could not open below its editor and opens beside it: ${messageOf(error)}`);
  }
  return { panel: made.panel ?? create(vscode.ViewColumn.Beside), editorGroup };
}

/** The panel of the entry, taken from it: its disposal keeps the entry. */
function takePanel(entry: Entry): vscode.WebviewPanel | undefined {
  const { panel } = entry;
  entry.panel = undefined;
  return panel;
}

/**
 * One results panel per editor, opened below it on the first run and bound to it: it follows the editor into another
 * group, comes forward with it and closes with it. A hidden panel is taken down and rebuilt from `ResultsRun`.
 */
export class ResultsPanels implements ResultsView {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  /** Placing is one at a time: a second document decides on the layout that the first one has made. */
  private placing: Promise<unknown> = Promise.resolve();
  private readonly subscriptions: vscode.Disposable[];
  private followTimer: ReturnType<typeof setTimeout> | undefined;
  /** The document whose editor became the active one since the panels last followed the editors. */
  private activated: string | undefined;
  private readonly warn: Warn = (message) => this.deps.log?.warn(message);

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: ResultsHost,
    private readonly deps: GridDeps,
  ) {
    const follow = (): void => this.scheduleFollow();
    this.subscriptions = [
      vscode.window.tabGroups.onDidChangeTabs(follow),
      vscode.window.tabGroups.onDidChangeTabGroups(follow),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.activated = editor?.document.uri.toString();
        this.updateContext();
        follow();
      }),
    ];
  }

  /** A run shows collapsed results again, and puts results that were dragged away back below the editor. */
  begin(target: ResultsTarget, script: { text: string; startedAt: number; built?: boolean }): void {
    const known = this.entries.get(target.key);
    const entry = known ?? this.open(target);
    entry.title = `${target.title} · results`;
    if (entry.panel) {
      entry.panel.title = entry.title;
    }
    entry.run.begin(script.text, script.built === true);
    if (known?.collapsed) {
      this.collapse(target.key, false);
    } else if (known?.panel) {
      this.keepBelow(target.key, known);
    }
    this.updateContext();
  }

  event(target: ResultsTarget, event: SqlEvent): void {
    this.entries.get(target.key)?.run.event(event);
  }

  end(target: ResultsTarget, summary: ResultsRunSummary): void {
    this.entries.get(target.key)?.run.end(summary);
  }

  /** Brings the panel forward; the focus stays where it is. */
  reveal(target: ResultsTarget): void {
    this.entries.get(target.key)?.panel?.reveal(undefined, true);
  }

  isCollapsed(key: string): boolean {
    return this.entries.get(key)?.collapsed === true;
  }

  /** Closes the results of the document and keeps the run, or shows the run below its editor again. */
  collapse(key: string, collapsed: boolean): void {
    const entry = this.entries.get(key);
    // A panel that is still being made cannot be collapsed yet.
    if (!entry || entry.collapsed === collapsed || (collapsed && !entry.panel)) {
      return;
    }
    entry.collapsed = collapsed;
    if (collapsed) {
      entry.run.pageGone();
      takePanel(entry)?.dispose();
    } else {
      this.place(key, entry);
    }
    this.updateContext();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.followTimer);
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    for (const { panel } of [...this.entries.values()]) {
      panel?.dispose();
    }
  }

  /** The entry exists at once, so that the run is kept while the group for the panel is made. */
  private open(target: ResultsTarget): Entry {
    const entry: Entry = {
      title: `${target.title} · results`,
      collapsed: false,
      run: new ResultsRun((message: ExtensionMessage) => void entry.panel?.webview.postMessage(message)),
    };
    this.entries.set(target.key, entry);
    this.place(target.key, entry);
    return entry;
  }

  private place(key: string, entry: Entry): void {
    const made = this.enqueue(() =>
      createBelow(key, (column) => this.makePanel(key, entry, column), this.warn),
    );
    void made.then(
      ({ panel, editorGroup }) => {
        entry.editorGroup = editorGroup;
        if (this.disposed) {
          panel.dispose();
        }
      },
      (error: unknown) => {
        // Without a panel the entry would swallow every later run of this editor.
        this.forget(key, entry);
        void vscode.window.showErrorMessage(`Could not open the results panel: ${messageOf(error)}`);
      },
    );
  }

  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    const done = this.placing.then(step);
    this.placing = done.catch(() => undefined);
    return done;
  }

  private makePanel(key: string, entry: Entry, column: vscode.ViewColumn): vscode.WebviewPanel {
    const { run } = entry;
    const panel = createPanel(this.extensionUri, {
      viewType: 'aantje.results',
      title: entry.title,
      script: 'grid-client.js',
      // Draws the plans of Explain and Analysis; the data grid does not load it.
      before: ['plan-client.js'],
      column: { viewColumn: column, preserveFocus: true },
      css: GRID_CSS,
    });
    entry.panel = panel;
    receiveFrom(panel, this.deps, (message) => void this.handle(key, entry, message));
    panel.onDidChangeViewState(({ webviewPanel }) => {
      if (!webviewPanel.visible) {
        run.pageGone();
      }
    });
    // Collapsing and closing with the editor take the panel first; a panel that the user closed forgets the run.
    panel.onDidDispose(() => {
      if (entry.panel === panel) {
        entry.panel = undefined;
        this.forget(key, entry);
      }
    });
    return panel;
  }

  private forget(key: string, entry: Entry): void {
    if (this.entries.get(key) === entry) {
      this.entries.delete(key);
      this.updateContext();
    }
  }

  private updateContext(): void {
    const key = vscode.window.activeTextEditor?.document.uri.toString();
    const entry = key === undefined ? undefined : this.entries.get(key);
    this.host.setContext?.('aantje.queryHasResults', entry !== undefined);
    this.host.setContext?.('aantje.queryResultsCollapsed', entry?.collapsed === true);
  }

  private keepBelow(key: string, entry: Entry): void {
    void this.enqueue(async () => {
      const editor = editorOf(key);
      const group = groupInColumn(editor?.viewColumn);
      if (editor && group) {
        await this.moveBelow(entry, editor.document, group);
      }
    }).catch((error: unknown) => {
      // The panel stays where it is.
      this.warn(`The results panel could not move below its editor: ${messageOf(error)}`);
    });
  }

  /** Puts the panel below the editor in `group` and brings it forward there; once per group, so that a failure does not repeat. */
  private async moveBelow(
    entry: Entry,
    document: vscode.TextDocument,
    group: vscode.TabGroup,
  ): Promise<void> {
    const { panel } = entry;
    if (!panel) {
      return;
    }
    entry.editorGroup = group;
    await putBelow(
      document,
      group,
      (column) => {
        if (entry.panel === panel && (panel.viewColumn !== column || !panel.visible)) {
          panel.reveal(column, true);
        }
      },
      this.warn,
    );
  }

  private scheduleFollow(): void {
    if (this.entries.size === 0) {
      this.activated = undefined; // No results to bring forward, now or after the next run.
    }
    if (this.disposed || this.entries.size === 0 || this.followTimer !== undefined) {
      return;
    }
    this.followTimer = setTimeout(() => {
      this.followTimer = undefined;
      void this.enqueue(() => this.follow()).catch((error: unknown) => {
        // The panels stay where they are.
        this.warn(`The results panels could not follow their editors: ${messageOf(error)}`);
      });
    }, FOLLOW_DELAY_MS);
  }

  // A group that VS Code closed meanwhile would still count as showing its documents.
  private async follow(): Promise<void> {
    await settledLayout();
    const activated = this.activated;
    this.activated = undefined;
    for (const action of decide(this.snapshot(activated))) {
      await this.apply(action);
    }
  }

  private snapshot(activated: string | undefined): BindingSnapshot<vscode.TabGroup> {
    const { all, activeTabGroup } = vscode.window.tabGroups;
    return {
      groups: all.map((group) => ({ group, column: group.viewColumn, keys: group.tabs.flatMap(keysOfTab) })),
      activeGroup: activeTabGroup,
      activated,
      entries: [...this.entries].map(([key, { panel, editorGroup, collapsed }]) => {
        const front = groupInColumn(panel?.viewColumn)?.activeTab;
        return {
          key,
          editorGroup,
          collapsed,
          column: panel?.viewColumn,
          covered: panel?.visible === false && front !== undefined && isResultsTab(front),
        };
      }),
    };
  }

  private async apply(action: BindingAction<vscode.TabGroup>): Promise<void> {
    const entry = this.entries.get(action.key);
    if (!entry) {
      return;
    }
    if (action.kind === 'close') {
      this.forget(action.key, entry);
      takePanel(entry)?.dispose();
      return;
    }
    if (action.kind === 'front') {
      entry.panel?.reveal(undefined, true);
      return;
    }
    const document = documentOf(action.key);
    if (document) {
      await this.moveBelow(entry, document, action.group);
    }
  }

  private async handle(key: string, { run }: Entry, message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        run.pageReady();
        break;
      case 'reveal': {
        const range = run.revealRange(message.index);
        if (range) {
          this.host.revealStatement(key, range.offset, range.length);
        }
        break;
      }
      case 'openQuery':
        this.host.openQuery?.(key);
        break;
      case 'copy':
      case 'export':
        await transfer(this.deps, message);
        break;
    }
  }
}
