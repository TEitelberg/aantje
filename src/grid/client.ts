/// <reference lib="dom" />
// The script of the data grid and of the results page (`dist/grid-client.js`). It routes the messages of the extension:
// `data` to the grid of a table preview (grid-view.ts), the results messages to the results page (results-page.ts).
import { isObject, own } from '../guards';
import { createApp } from '../shell/page';
import type { GridData } from '../data/types';
import { gridView } from './grid-view';
import type { HostPort } from './grid-view';
import { handOver } from './result-tab';
import type { ResultTab } from './result-tab';
import { fileStem } from './model';
import {
  isGridData,
  isGridRequest,
  isPageSettings,
  isResultsMessage,
  isResultsUpdate,
  isSummaryState,
} from './protocol';
import type { PageSettings, WebviewMessage } from './protocol';
import { resultsPage } from './results-page';
import type { ResultsPage } from './results-page';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
// Until the extension sends the settings, those of a fresh install.
let settings: PageSettings = { markdownNull: 'empty' };
const host: HostPort = {
  post: (message) => vscode.postMessage(message),
  getState: () => vscode.getState(),
  setState: (state) => vscode.setState(state),
  settings: () => settings,
};
const app = createApp();
document.body.append(app);

/**
 * VS Code gives a command of the context menu of the page the `data-vscode-context` of the element under the mouse
 * and of everything around it: the id of the panel there brings the command back to this page.
 */
function namePanel(panel: string | undefined): void {
  if (panel === undefined) app.removeAttribute('data-vscode-context');
  else app.setAttribute('data-vscode-context', JSON.stringify({ aantjePanel: panel }));
}

// The grid of the preview; the statistics of its columns and the requests of the extension go to it.
let preview: ResultTab | undefined;

/** `summary`: the extension computes the statistics of the columns of this grid (a table preview). */
function show(data: GridData, summary: boolean): void {
  const grid = gridView(host, data, {
    persist: true,
    fileStem: fileStem(data.table),
    ...(summary ? { summarize: () => host.post({ type: 'summarize' }) } : {}),
  });
  preview = grid;
  app.replaceChildren(...grid.elements);
  grid.placed();
}

let results: ResultsPage | undefined;
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (isObject(message) && own(message, 'type') === 'data') {
    const data = own(message, 'data');
    if (isGridData(data)) {
      show(data, own(message, 'summary') === true);
    }
  } else if (isObject(message) && own(message, 'type') === 'summary') {
    const state = own(message, 'state');
    if (isSummaryState(state)) {
      preview?.grid?.summary(state);
    }
  } else if (isObject(message) && own(message, 'type') === 'settings') {
    const sent = own(message, 'settings');
    if (isPageSettings(sent)) {
      settings = sent;
      namePanel(sent.panel);
    }
  } else if (isGridRequest(message)) {
    // A result set of the results page, or the grid of a preview.
    if (message.set === undefined) handOver(preview?.grid, message);
    else results?.request(message);
  } else if (isResultsMessage(message)) {
    results ??= resultsPage(app, host);
    results.show(message);
  } else if (isResultsUpdate(message)) {
    results?.update(message);
  }
});
host.post({ type: 'ready' });
