/// <reference lib="dom" />
// The script of the data grid and of the results page (`dist/grid-client.js`). It routes the messages of the extension:
// `data` to the grid of a table preview (grid-view.ts), the results messages to the results page (results-page.ts).
import { isObject, own } from '../guards';
import { createApp } from '../shell/page';
import type { GridData } from '../data/types';
import { gridView } from './grid-view';
import type { HostPort } from './grid-view';
import { csvFileName } from './model';
import { isGridData, isResultsMessage } from './protocol';
import type { ResultsMessage, WebviewMessage } from './protocol';
import { resultsPage } from './results-page';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const host: HostPort = {
  post: (message) => vscode.postMessage(message),
  getState: () => vscode.getState(),
  setState: (state) => vscode.setState(state),
};
const app = createApp();
document.body.append(app);

function show(data: GridData): void {
  const grid = gridView(host, data, { persist: true, fileName: csvFileName(data.table) });
  app.replaceChildren(...grid.elements);
  grid.placed();
}

let showResults: ((message: ResultsMessage) => void) | undefined;
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (isObject(message) && own(message, 'type') === 'data') {
    const data = own(message, 'data');
    if (isGridData(data)) {
      show(data);
    }
  } else if (isResultsMessage(message)) {
    showResults ??= resultsPage(app, host);
    showResults(message);
  }
});
host.post({ type: 'ready' });
