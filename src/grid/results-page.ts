/// <reference lib="dom" />
// The results page of the SQL editor: a tab for the messages and one for each result set. The rules (which tab is
// selected, the texts) are in results-model.ts; the views of the tabs are in results-views.ts.
import { el } from '../shell/dom';
import { tabAfterKey } from '../shell/blocks';
import type { HostPort } from './grid-view';
import type { ResultsMessage } from './protocol';
import type { ResultTab } from './result-tab';
import { applyMessage, endText, selectedTab, tabsOf, transactionText } from './results-model';
import type { ResultsRunState, TabId } from './results-model';
import { messagesView, resultView } from './results-views';
import type { MessagesView } from './results-views';

/** Builds the page in `app`; the result takes each results message of the extension and shows it. */
export function resultsPage(app: HTMLElement, host: HostPort): (message: ResultsMessage) => void {
  let run: ResultsRunState | undefined;
  let chosen: TabId | undefined;
  // Built when its tab is first selected and kept, so that sort and filters stay.
  let grids = new Map<number, ResultTab>();
  let shown: TabId | undefined;
  // Kept for the whole run: a script of thousands of statements sends two events for each, and each one renders.
  let messages: MessagesView | undefined;
  // The tab buttons live as long as the run, so that a click or the focus is not lost when an event renders again.
  const tabButtons = new Map<TabId, HTMLButtonElement>();
  let buttons: HTMLButtonElement[] = [];
  const tablist = el('div', 'tabs');
  tablist.setAttribute('role', 'tablist');
  const runLine = el('span', 'run');
  runLine.setAttribute('role', 'status');
  runLine.setAttribute('aria-live', 'polite');
  // A statement that aantje built (a CTE on its own) is not in the document; this puts it into an editor.
  const open = el('button', 'open', 'Open as New Query');
  open.title = 'Opens the statement that ran in a new SQL editor on the same connection';
  open.hidden = true;
  open.addEventListener('click', () => host.post({ type: 'openQuery' }));
  const bar = el('div', 'tabbar');
  bar.append(tablist, runLine, open);
  const pane = el('div', 'pane');
  pane.setAttribute('role', 'tabpanel');
  app.replaceChildren(bar, pane);

  tablist.addEventListener('keydown', (event) => {
    const ids = run ? tabsOf(run).map((tab) => tab.id) : [];
    const current = run ? ids.indexOf(selectedTab(run, chosen)) : 0;
    const position = tabAfterKey(event.key, current, ids.length);
    if (position !== undefined) {
      event.preventDefault();
      chosen = ids[position];
      render();
      buttons[position]?.focus();
    }
  });

  function renderTabs(current: ResultsRunState, selected: TabId): void {
    buttons = tabsOf(current).map((tab) => {
      const on = tab.id === selected;
      let button = tabButtons.get(tab.id);
      if (!button) {
        button = el('button', undefined, tab.label);
        button.setAttribute('role', 'tab');
        button.addEventListener('click', () => {
          chosen = tab.id;
          render();
        });
        tabButtons.set(tab.id, button);
      }
      button.className = on ? 'tab selected' : 'tab';
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      return button;
    });
    tablist.replaceChildren(...buttons);
  }

  function render(): void {
    if (!run) {
      return;
    }
    const current = run;
    const selected = selectedTab(current, chosen);
    renderTabs(current, selected);
    runLine.textContent = [endText(current.end), transactionText(current.end)]
      .filter((part) => part !== '')
      .join(' · ');
    open.hidden = current.built !== true;
    if (selected === 'messages') {
      messages ??= messagesView(host);
      messages.update(current);
      if (shown !== selected) {
        pane.replaceChildren(messages.element);
        shown = selected;
      }
    } else if (shown !== selected) {
      let grid = grids.get(selected);
      if (!grid) {
        grid = resultView(host, current, selected);
        grids.set(selected, grid);
      }
      pane.replaceChildren(...grid.elements);
      grid.placed();
      shown = selected;
    }
  }

  return (message) => {
    if (message.type === 'results-begin') {
      chosen = undefined;
    }
    if (message.type === 'results-begin' || message.type === 'results-state') {
      for (const grid of grids.values()) grid.dispose?.();
      grids = new Map();
      shown = undefined;
      messages = undefined;
      tabButtons.clear();
    }
    run = applyMessage(run, message);
    render();
  };
}
