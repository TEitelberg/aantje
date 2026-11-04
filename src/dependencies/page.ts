/// <reference lib="dom" />
// Browser side of the Dependencies report: state and events; the DOM is built in render.ts.
import { cardGrid, pageHeader, toolbar } from '../shell/blocks';
import { scopeSuffix } from '../shell/scope';
import { el } from '../shell/dom';
import type { Page, PageContext, PageKind } from '../shell/page';
import { readTheme, severityColor } from '../shell/theme';
import type { Theme } from '../shell/theme';
import type { DependenciesRequest } from './actions';
import { graphPane } from './graph-pane';
import type { DependenciesMarkdownView } from './markdown';
import { DEPENDENCIES_KIND_LABEL, MAX_DEPTH, cards, nameAt } from './model';
import type { DependenciesData, Direction } from './model';
import type { GraphReach } from './picture';
import { isDependenciesMessage } from './protocol';
import type { DependenciesActionId } from './protocol';
import {
  detailChildren,
  impactSection,
  issuesChildren,
  listChildren,
  listView,
  noteChildren,
  toolbarChildren,
} from './render';
import { restoreDependenciesChoices, saveChoices } from './state';
import type { DependenciesShow } from './state';

function createDependenciesPage(context: PageContext): Page<DependenciesData> {
  let data: DependenciesData | undefined;
  let show: DependenciesShow = 'list';
  let reach: GraphReach = 'connected';
  let direction: Direction = 'usedBy';
  let depth = MAX_DEPTH;
  let text = '';
  let selected: number | undefined;
  // An object to zoom in on when the graph is drawn next.
  let centre: number | undefined;
  let theme: Theme;
  let listed: readonly number[] = [];
  let buttons: HTMLElement[] = [];
  // The controls that only one of the two views has.
  let listOnly: HTMLElement[] = [];
  let graphOnly: HTMLElement[] = [];

  const notes = el('div', 'notes');
  const list = el('div', 'objects');
  const graph = graphPane(
    (current) => listView(current, { text: '', direction, depth, selected }).emptyText,
    (node) => select(node),
    (node) => select(node, true),
  );
  const detail = el('section', 'detail');
  // The pane is replaced when the selection changes; it takes the focus that the button in it loses.
  detail.tabIndex = -1;
  const issues = el('div', 'issues');

  const ask = (action: DependenciesActionId, node: number): void => {
    const request: DependenciesRequest = { action, node };
    context.post({ type: 'action', ...request });
  };

  function save(): void {
    if (data) {
      context.state.set(saveChoices(data, { show, reach, direction, depth, text, selected }));
    }
  }

  function drawGraph(): void {
    if (data && show === 'graph') {
      graph.draw(data, { directions: [direction], depth, reach }, theme, selected, centre);
    } else {
      graph.clear();
    }
    centre = undefined;
  }

  // Shows the objects as a list or as a graph; the choices stay.
  function showAs(next: DependenciesShow): void {
    show = next;
    list.hidden = show !== 'list';
    graph.element.hidden = show !== 'graph';
    listOnly.forEach((control) => (control.hidden = show !== 'list'));
    graphOnly.forEach((control) => (control.hidden = show !== 'graph'));
    drawGraph();
    drawDetail();
    save();
  }

  function visualize(node: number): void {
    show = 'graph';
    selected = node;
    centre = node;
    render();
    detail.focus();
  }

  function drawDetail(): void {
    detail.replaceChildren(...detailChildren(data, selected, ask, show === 'list' ? visualize : undefined));
  }

  // A double click in the graph also zooms in on the object.
  function select(node: number, zoom = false): void {
    selected = node;
    listed.forEach((at, index) => buttons[index]?.setAttribute('aria-selected', String(at === selected)));
    graph.mark(selected, zoom);
    drawDetail();
    save();
  }

  function drawList(): void {
    if (!data) return;
    const view = listView(data, { text, direction, depth, selected });
    const drawn = listChildren(view, select);
    listed = view.nodes;
    buttons = drawn.buttons;
    notes.replaceChildren(...noteChildren(data, view.cycle));
    list.replaceChildren(...drawn.children);
    issues.replaceChildren(...issuesChildren(data, view.shown));
  }

  const changed = (): void => {
    drawList();
    drawGraph();
    save();
  };

  function controls(current: DependenciesData): HTMLElement {
    const bar = toolbarChildren(current, { show, reach, direction, depth, text }, (change) => {
      if (change.show) {
        showAs(change.show);
        return;
      }
      reach = change.reach ?? reach;
      direction = change.direction ?? direction;
      depth = change.depth ?? depth;
      text = change.text ?? text;
      changed();
    });
    listOnly = bar.listOnly;
    graphOnly = bar.graphOnly;
    return toolbar(...bar.children);
  }

  function render(): void {
    theme = readTheme();
    if (!data) return;
    const current = data;
    const { target } = current;
    const targetNode = target === null ? undefined : current.nodes[target];
    const header = pageHeader(context, {
      title:
        target === null
          ? `Dependencies${scopeSuffix(current.scope)}`
          : `Dependencies of ${nameAt(current, target)}`,
      subtitle: `${current.connection} · snapshot @${current.snapshot}${targetNode ? ` · ${DEPENDENCIES_KIND_LABEL[targetNode.kind]}` : ` · ${current.nodes.length} objects with dependencies`}`,
      refresh: 'Read the dependencies again at the snapshot that the tree shows',
      view: (): DependenciesMarkdownView => ({ direction, depth, text, reach }),
    });
    const main = el('main');
    main.append(
      cardGrid(cards(current), severityColor(theme)),
      controls(current),
      notes,
      list,
      graph.element,
      ...(target === null ? [] : [impactSection(current, target, ask)]),
      detail,
      issues,
    );
    context.app.replaceChildren(header.element, main);
    drawList();
    showAs(show);
    header.settle();
  }

  return {
    show(next) {
      data = next;
      const kept = restoreDependenciesChoices(context.state.get(), next);
      show = kept?.show ?? 'list';
      reach = kept?.reach ?? 'connected';
      direction = kept?.direction ?? 'usedBy';
      depth = kept?.depth ?? MAX_DEPTH;
      text = kept?.text ?? '';
      selected = kept?.selected ?? next.target ?? undefined;
      render();
    },
    redraw: render,
    resize() {
      graph.resize();
    },
  };
}

export const dependenciesPage: PageKind<DependenciesData> = {
  type: 'dependencies',
  isMessage: isDependenciesMessage,
  create: createDependenciesPage,
};
