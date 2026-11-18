/// <reference lib="dom" />
// The results page of the SQL editor: a tab for the messages, one for each result set and one for the chart of each
// result set of rows. The rules (which tab is selected, the texts) are in results-model.ts; the views of the tabs are
// in results-views.ts.
import { el } from '../shell/dom';
import { tabAfterKey } from '../shell/blocks';
import { chartMemory, rememberChart } from './chart-view';
import type { ChartViewTab } from './chart-view';
import type { HostPort } from './grid-view';
import type { GridRequest, ResultsMessage, ResultsUpdate } from './protocol';
import { handOver } from './result-tab';
import type { ResultTab } from './result-tab';
import {
  applyMessage,
  chartSetOf,
  endText,
  hasChart,
  selectedTab,
  tabsOf,
  transactionText,
} from './results-model';
import type { ResultsRunState, TabId } from './results-model';
import { chartTabView, messagesView, resultView } from './results-views';
import type { MessagesView } from './results-views';

/** The results page: it shows each message of the run, and hands what the extension computed to its result set. */
export interface ResultsPage {
  show(message: ResultsMessage): void;
  update(update: ResultsUpdate): void;
  /** A copy of the context menu, or the format of Export as File, for the grid of a result set. */
  request(request: GridRequest): void;
}

/** Builds the page in `app`. */
export function resultsPage(app: HTMLElement, host: HostPort): ResultsPage {
  let run: ResultsRunState | undefined;
  let chosen: TabId | undefined;
  // Built when its tab is first selected and kept, so that sort, filters and the chart stay.
  let views = new Map<TabId, ResultTab>();
  let charts = new Map<number, ChartViewTab>();
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

  const selected = (current: ResultsRunState): TabId =>
    selectedTab(current, chosen, chartMemory(host)?.open === true);

  /**
   * The user chose a tab. Between the rows of a result set and its chart, the one chosen last is noted with the chart,
   * so that the next run opens it again.
   */
  function choose(id: TabId): void {
    chosen = id;
    render();
    const set = chartSetOf(id);
    if (set !== undefined) {
      const choice = charts.get(set)?.choice();
      if (choice) rememberChart(host, { choice, open: true });
    } else if (typeof id === 'number' && hasChart(run?.resultSets[id])) {
      const choice = charts.get(id)?.choice() ?? chartMemory(host)?.choice;
      if (choice) rememberChart(host, { choice, open: false });
    }
  }

  tablist.addEventListener('keydown', (event) => {
    const ids = run ? tabsOf(run).map((tab) => tab.id) : [];
    const current = run ? ids.indexOf(selected(run)) : 0;
    const position = tabAfterKey(event.key, current, ids.length);
    const id = position === undefined ? undefined : ids[position];
    if (position !== undefined && id !== undefined) {
      event.preventDefault();
      choose(id);
      buttons[position]?.focus();
    }
  });

  function renderTabs(current: ResultsRunState, on: TabId): void {
    buttons = tabsOf(current).map((tab) => {
      let button = tabButtons.get(tab.id);
      if (!button) {
        button = el('button', undefined, tab.label);
        button.setAttribute('role', 'tab');
        button.addEventListener('click', () => choose(tab.id));
        tabButtons.set(tab.id, button);
      }
      // `Result` becomes `Result 1` once a second result set of the run arrives.
      if (button.textContent !== tab.label) button.textContent = tab.label;
      button.className = tab.id === on ? 'tab selected' : 'tab';
      button.setAttribute('aria-selected', String(tab.id === on));
      button.tabIndex = tab.id === on ? 0 : -1;
      return button;
    });
    tablist.replaceChildren(...buttons);
  }

  /** The view of a tab other than Messages, made when the tab is first shown. */
  function viewOf(current: ResultsRunState, id: Exclude<TabId, 'messages'>): ResultTab {
    const set = chartSetOf(id);
    if (set === undefined) return resultView(host, current, typeof id === 'number' ? id : -1);
    const chart = chartTabView(host, current, set);
    if (!chart) return resultView(host, current, -1);
    charts.set(set, chart);
    return chart;
  }

  function render(): void {
    if (!run) {
      return;
    }
    const current = run;
    const on = selected(current);
    renderTabs(current, on);
    runLine.textContent = [endText(current.end), transactionText(current.end)]
      .filter((part) => part !== '')
      .join(' · ');
    open.hidden = current.built !== true;
    if (on === 'messages') {
      messages ??= messagesView(host);
      messages.update(current);
      if (shown !== on) {
        pane.replaceChildren(messages.element);
        shown = on;
      }
    } else if (shown !== on) {
      let view = views.get(on);
      if (!view) {
        view = viewOf(current, on);
        views.set(on, view);
      }
      pane.replaceChildren(...view.elements);
      view.placed();
      shown = on;
    }
  }

  return {
    show: (message) => {
      if (message.type === 'results-begin') {
        chosen = undefined;
      }
      if (message.type === 'results-begin' || message.type === 'results-state') {
        for (const view of views.values()) view.dispose?.();
        views = new Map();
        charts = new Map();
        shown = undefined;
        messages = undefined;
        tabButtons.clear();
      }
      run = applyMessage(run, message);
      render();
    },
    update: (update) => {
      if (update.type === 'results-summary') views.get(update.set)?.grid?.summary(update.state);
      else charts.get(update.set)?.receive(update.choice, update.state);
    },
    request: (request) => {
      if (request.set !== undefined) handOver(views.get(request.set)?.grid, request);
    },
  };
}
