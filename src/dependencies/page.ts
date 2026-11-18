/// <reference lib="dom" />
// Browser side of the Dependencies report: state and events; the DOM is built in render.ts and lineage-render.ts.
import { cardGrid, pageHeader, tabBar, toolbar } from '../shell/blocks';
import { el } from '../shell/dom';
import { pagedTable } from '../shell/paged-table';
import { reportPage } from '../shell/report-page';
import type { PageShell } from '../shell/report-page';
import { reportHeading } from '../shell/report-heading';
import { scopeSchema } from '../shell/scope';
import { readTheme, severityColor } from '../shell/theme';
import type { DependenciesRequest } from './actions';
import { graphPane } from './graph-pane';
import type { GraphPane } from './graph-pane';
import { lineageChildren } from './lineage-render';
import { lineageName } from './lineage-view';
import type { DependenciesMarkdownView } from './markdown';
import { DEPENDENCIES_KIND_LABEL, MAX_DEPTH, cards, nameAt } from './model';
import type { DependenciesData } from './model';
import { isDependenciesMessage } from './protocol';
import type { DependenciesActionId } from './protocol';
import {
  LAKE_COLUMNS,
  depthPicker,
  emptyLakeText,
  headerIcons,
  lakeTableRows,
  noteChildren,
  objectTables,
  reachGroup,
} from './render';
import type { Act } from './render';
import { dependenciesTabs, firstTab, restoreDependenciesChoices, saveChoices } from './state';
import type { DependenciesChoices } from './state';

/** The blocks of the page that stay while it shows data: the tabs, the panel of the tab shown, the graph. */
interface Blocks {
  readonly tabRow: HTMLElement;
  readonly panel: HTMLElement;
  readonly graph: GraphPane;
}

/** What the page holds between events: the data and the choices. */
interface Page extends Blocks {
  readonly shell: PageShell;
  readonly data: DependenciesData;
  choices: DependenciesChoices;
}

// VS Code may take a hidden panel down; the saved choices bring it back as it was.
const save = (page: Page): void => page.shell.context.state.set(saveChoices(page.data, page.choices));

const change = (page: Page, next: Partial<DependenciesChoices>): void => {
  page.choices = { ...page.choices, ...next };
  save(page);
};

/** The page names an action and the index of an object; the extension checks both against the data it sent. */
function ask(page: Page, action: DependenciesActionId, node: number): void {
  const request: DependenciesRequest = { action, node };
  page.shell.context.post({ type: 'action', ...request });
}

// The title and the subtitle of the header: the object or its column, or the lake or schema.
function headerText(current: DependenciesData): { readonly title: string; readonly subtitle: string } {
  const { target, lineage } = current;
  const node = target === null ? undefined : current.nodes[target];
  const title =
    target === null
      ? reportHeading('Dependencies', scopeSchema(current.scope))
      : lineage?.focus === undefined
        ? reportHeading('Dependencies', nameAt(current, target))
        : reportHeading('Column Lineage', lineageName(current, lineage.focus));
  return {
    title,
    subtitle: `${current.connection} · snapshot @${current.snapshot}${node ? ` · ${DEPENDENCIES_KIND_LABEL[node.kind]}` : ` · ${current.nodes.length} objects with dependencies`}`,
  };
}

/** The icons of a row: Visualize opens the graph on the object, the others ask the extension. */
const actOf = (page: Page): Act => ({
  ask: (action, node) => ask(page, action, node),
  visualize: (node) => {
    change(page, { tab: 'graph', selected: node });
    drawTab(page, { refocus: true, frame: true });
  },
});

// A click in the graph selects an object, and a click on the selected one takes the selection away; the zoom stays.
function pick(page: Page, node: number): void {
  change(page, { selected: page.choices.selected === node ? undefined : node });
  page.graph.mark(page.choices.selected);
}

// A double click selects the object and frames what is connected to it.
function frame(page: Page, node: number): void {
  change(page, { selected: node });
  page.graph.mark(node, true);
}

function drawGraph(page: Page, framed = false): void {
  const { reach, tab, selected } = page.choices;
  page.graph.draw(
    page.data,
    { reach, mode: tab === 'columnGraph' ? 'columns' : 'objects' },
    readTheme(),
    selected,
    framed,
  );
}

// The table of the lake or a schema: a page at a time, with a filter box; a click on a row opens nothing.
function lakeTab(page: Page): HTMLElement[] {
  const rows = lakeTableRows(page.data, actOf(page));
  const table = pagedTable<number>({
    columns: LAKE_COLUMNS,
    rows,
    noun: ['object', 'objects'],
    noMatch: 'No object matches the filter.',
    none: emptyLakeText(page.data),
    text: page.choices.text,
    page: page.choices.page,
    onChange: ({ text, page: shown }) => change(page, { text, page: shown }),
  });
  return rows.length === 0 ? [table.table] : [table.controls, table.table];
}

// The tables of an object below the depth, which applies to both; the depth keeps its focus when it changes them.
function objectsTab(page: Page): HTMLElement[] {
  const tables = el('div', 'object-tables');
  const draw = (): void =>
    tables.replaceChildren(...objectTables(page.data, page.choices.depth, actOf(page)));
  const depth = toolbar(
    depthPicker(page.choices.depth, (chosen) => {
      change(page, { depth: chosen });
      draw();
    }),
  );
  draw();
  return [depth, tables];
}

// The graph, below what the graph of an object holds; the graph is drawn once the panel is in the page.
function graphTab(page: Page): HTMLElement[] {
  if (page.data.target === null) return [page.graph.element];
  const reach = toolbar(
    reachGroup(page.choices.reach, (chosen) => {
      change(page, { reach: chosen });
      drawGraph(page);
    }),
  );
  return [reach, page.graph.element];
}

function tabContent(page: Page): HTMLElement[] {
  switch (page.choices.tab) {
    case 'list':
      return page.data.target === null ? lakeTab(page) : objectsTab(page);
    case 'columns':
      return lineageChildren(page.data);
    case 'graph':
    case 'columnGraph':
      return graphTab(page);
  }
}

/** The tabs and the tab shown; only a graph tab draws its graph. `frame` frames what is connected to the selection. */
function drawTab(page: Page, options: { readonly refocus?: boolean; readonly frame?: boolean } = {}): void {
  const bar = tabBar(dependenciesTabs(page.data), page.choices.tab, (id, refocus) => {
    change(page, { tab: id });
    drawTab(page, { refocus });
  });
  page.tabRow.replaceChildren(bar);
  page.graph.clear();
  page.panel.replaceChildren(...tabContent(page));
  if (page.choices.tab === 'graph' || page.choices.tab === 'columnGraph') {
    drawGraph(page, options.frame);
  }
  if (options.refocus) {
    (Array.from(bar.children) as HTMLElement[])
      .find((button) => button.getAttribute('aria-selected') === 'true')
      ?.focus();
  }
}

function render(page: Page): void {
  const { data } = page;
  const header = pageHeader(page.shell.context, {
    ...headerText(data),
    refresh: 'Read the dependencies again at the snapshot that the tree shows',
    view: (): DependenciesMarkdownView => ({
      depth: page.choices.depth,
      text: page.choices.text,
      reach: page.choices.reach,
    }),
    actions: headerIcons(data, (action, node) => ask(page, action, node)),
  });
  const notes = el('div', 'notes');
  notes.append(...noteChildren(data));
  const main = el('main');
  main.append(cardGrid(cards(data), severityColor(readTheme())), notes, page.tabRow, page.panel);
  page.shell.mount(header, main);
  drawTab(page);
}

/**
 * The key figures above the tabs. The lake and a schema have the table of their objects and the graph; an object the
 * tables of what it depends on and what uses it, its columns, and the graphs of its objects and of its columns. No pane:
 * the actions are icons in the rows, and those of the object of the report in the header.
 */
export const dependenciesPage = reportPage<DependenciesData>(
  'dependencies',
  isDependenciesMessage,
  (shell) => {
    const panel = el('section', 'tab-panel');
    panel.setAttribute('role', 'tabpanel');
    const tabRow = el('div', 'tab-row');
    let shown: Page | undefined;
    const graph = graphPane(
      emptyLakeText,
      (node) => {
        if (shown) pick(shown, node);
      },
      (node) => {
        if (shown) frame(shown, node);
      },
    );
    return {
      show(next) {
        const kept = restoreDependenciesChoices(shell.context.state.get(), next);
        shown = {
          shell,
          data: next,
          tabRow,
          panel,
          graph,
          choices: kept ?? { tab: firstTab(next), reach: 'connected', depth: MAX_DEPTH, text: '' },
        };
        render(shown);
        save(shown);
      },
      redraw() {
        if (shown) render(shown);
      },
      // The graph pane keeps its own chart.
      resize: () => graph.resize(),
    };
  },
);
