/// <reference lib="dom" />
// Browser side of the Dependencies report: state and events; the DOM is built in render.ts.
import { cardGrid, pageHeader, searchBox, toolbar } from '../shell/blocks';
import { scopeSuffix } from '../shell/scope';
import { el } from '../shell/dom';
import type { Page, PageContext, PageKind } from '../shell/page';
import { readTheme, severityColor } from '../shell/theme';
import type { Theme } from '../shell/theme';
import type { DependenciesRequest } from './actions';
import type { DependenciesMarkdownView } from './markdown';
import {
  DEPENDENCIES_KIND_LABEL,
  DEPTHS,
  DIRECTIONS,
  DIRECTION_LABEL,
  MAX_DEPTH,
  cards,
  nameAt,
} from './model';
import type { DependenciesData, Direction } from './model';
import { isDependenciesMessage } from './protocol';
import type { DependenciesActionId } from './protocol';
import {
  choice,
  detailChildren,
  impactSection,
  issuesChildren,
  listChildren,
  listView,
  noteChildren,
} from './render';
import { restoreDependenciesChoices, saveChoices } from './state';

function createDependenciesPage(context: PageContext): Page<DependenciesData> {
  let data: DependenciesData | undefined;
  let direction: Direction = 'usedBy';
  let depth = MAX_DEPTH;
  let text = '';
  let selected: number | undefined;
  let theme: Theme;
  let listed: readonly number[] = [];
  let buttons: HTMLElement[] = [];

  const notes = el('div', 'notes');
  const list = el('div', 'objects');
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
      context.state.set(saveChoices(data, { direction, depth, text, selected }));
    }
  }

  function drawDetail(): void {
    detail.replaceChildren(...detailChildren(data, selected, ask));
  }

  function select(node: number): void {
    selected = node;
    listed.forEach((at, index) => buttons[index]?.setAttribute('aria-selected', String(at === selected)));
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
    save();
  };

  function controls(current: DependenciesData): HTMLElement {
    if (current.target === null) {
      return toolbar(
        searchBox('Object', text, (typed) => {
          text = typed;
          changed();
        }),
      );
    }
    return toolbar(
      choice(
        'Direction',
        DIRECTIONS.map((value) => ({ value, text: DIRECTION_LABEL[value] })),
        direction,
        (value) => {
          direction = value;
          changed();
        },
      ),
      choice(
        'Depth',
        DEPTHS.map((value) => ({ value, text: `Depth ${value}` })),
        depth,
        (value) => {
          depth = value;
          changed();
        },
      ),
    );
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
      view: (): DependenciesMarkdownView => ({ direction, depth, text }),
    });
    const main = el('main');
    main.append(
      cardGrid(cards(current), severityColor(theme)),
      controls(current),
      notes,
      list,
      ...(target === null ? [] : [impactSection(current, target, ask)]),
      detail,
      issues,
    );
    context.app.replaceChildren(header.element, main);
    drawList();
    drawDetail();
    header.settle();
  }

  return {
    show(next) {
      data = next;
      const kept = restoreDependenciesChoices(context.state.get(), next);
      direction = kept?.direction ?? 'usedBy';
      depth = kept?.depth ?? MAX_DEPTH;
      text = kept?.text ?? '';
      selected = kept?.selected ?? next.target ?? undefined;
      render();
    },
    redraw: render,
    resize() {},
  };
}

export const dependenciesPage: PageKind<DependenciesData> = {
  type: 'dependencies',
  isMessage: isDependenciesMessage,
  create: createDependenciesPage,
};
