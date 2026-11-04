/// <reference lib="dom" />
// The one script of all report pages (`dist/report-client.js`); the first message names the report kind to build.
import { isObject, own } from '../guards';
import { empty } from './blocks';
import { pageKinds as kinds } from './kinds';
import { createApp } from './page';
import type { Page, PageKind } from './page';
import { isStaleMessage } from './protocol';
import type { ActionMessage, ShellRequest } from './protocol';

declare function acquireVsCodeApi(): {
  postMessage(message: ShellRequest | ActionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const app = createApp();

// The page of this panel: the kind the first usable message named; later messages must match it.
let shown: { readonly kind: PageKind<unknown>; readonly page: Page<unknown> } | undefined;

// Shown above the page from the moment the extension says the data is out of date until new data arrives.
const staleNote = document.createElement('p');
staleNote.hidden = true;
staleNote.className = 'stale-note';
staleNote.setAttribute('role', 'status');
staleNote.textContent =
  'The lake changed after this report was read, so its numbers may be out of date. Press Refresh to read it again.';

// A page draws by replacing the children of the app (a tab, a filter, a theme): the note stays above what it draws.
const replaceChildren = app.replaceChildren.bind(app);
app.replaceChildren = (...nodes: (Node | string)[]): void => {
  replaceChildren(...(staleNote.hidden ? nodes : [staleNote, ...nodes.filter((node) => node !== staleNote)]));
};

document.body.append(app);

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (isStaleMessage(message)) {
    if (shown) {
      staleNote.hidden = false;
      app.replaceChildren(staleNote, ...Array.from(app.children).filter((child) => child !== staleNote));
    }
    return;
  }
  const kind = kinds.find((candidate) => candidate.isMessage(message));
  if (kind?.isMessage(message) && (!shown || shown.kind === kind)) {
    shown ??= {
      kind,
      page: kind.create({
        app,
        post: (request) => vscode.postMessage(request),
        state: { get: () => vscode.getState(), set: (state) => vscode.setState(state) },
        refreshAsked: false,
      }),
    };
    staleNote.hidden = true;
    shown.page.show(message.data);
  } else if (!shown && isObject(message) && kinds.some(({ type }) => type === String(own(message, 'type')))) {
    // Otherwise the page would say "Reading..." for ever while waiting for data it can never use.
    app.replaceChildren(
      empty(
        'This page cannot read the data it was sent. Open it again; if that does not help, update aantje.',
      ),
    );
  }
});

window.addEventListener('resize', () => shown?.page.resize());

// VS Code changes the body class for a theme of another kind, and the root element variables on every theme change.
let redraw = 0;
const observer = new MutationObserver(() => {
  cancelAnimationFrame(redraw);
  redraw = requestAnimationFrame(() => shown?.page.redraw());
});
observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-id'] });
observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

app.replaceChildren(empty('Reading...'));
vscode.postMessage({ type: 'ready' });
