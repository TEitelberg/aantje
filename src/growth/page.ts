/// <reference lib="dom" />
// Browser side of the Growth report: state and events; the DOM is built in render.ts.
import { cardGrid, pageHeader } from '../shell/blocks';
import { drawChart } from '../shell/charts';
import type { Chart } from '../shell/charts';
import { el } from '../shell/dom';
import { scopeSuffix } from '../shell/scope';
import type { Page, PageContext, PageKind } from '../shell/page';
import { readTheme } from '../shell/theme';
import type { Theme } from '../shell/theme';
import type { GrowthActionRequest } from './actions';
import { growthOption } from './chart-options';
import type { GrowthMarkdownView } from './markdown';
import {
  growthCards,
  growthModelOf,
  growthScopeLabel,
  growthTableChoices,
  seriesOf,
  subtitle,
} from './model';
import type { GrowthData, GrowthXAxis, Metric, Step, TableChoice } from './model';
import { isGrowthMessage } from './protocol';
import { detailChildren, filters, growthPane, markRows, noteChildren, snapshotList } from './render';
import type { ListRow } from './render';
import { restoreGrowthChoices } from './state';

/** Keeps the choices when the same report is read again. */
function createGrowthPage(context: PageContext): Page<GrowthData> {
  let data: GrowthData;
  let choices: TableChoice[];
  let steps: Step[];
  let theme: Theme;
  let chart: Chart | undefined;
  let table: number | undefined;
  let metric: Metric = 'rows';
  let axis: GrowthXAxis = 'snapshot';
  let selected: number | undefined;
  let rows = new Map<number, ListRow>();

  const cards = el('div', 'cards-box');
  const notes = el('div', 'notes');
  const growth = el('section', 'growth');
  const list = el('section', 'list');
  const detail = el('section', 'detail');
  // The pane is replaced when the selection changes; it takes the focus that the button in it loses.
  detail.tabIndex = -1;

  const ask = (request: GrowthActionRequest): void => context.post({ type: 'action', ...request });

  const chartOption = () =>
    growthOption(
      {
        steps,
        metric,
        axis,
        scope: growthScopeLabel(choices, table),
        selected,
        contrast: theme.mode.startsWith('hc'),
      },
      theme.palette,
    );

  function drawGrowth(): void {
    chart?.dispose();
    chart = undefined;
    const pane = growthPane(metric, growthScopeLabel(choices, table), steps.length > 0);
    growth.replaceChildren(...pane.children);
    if (pane.box) {
      chart = drawChart(pane.box, theme.chart, chartOption(), undefined, (index) => {
        const step = steps[index];
        if (step) {
          select(step.id);
        }
      });
    }
  }

  function drawList(): void {
    const drawn = snapshotList(steps, metric, select);
    rows = drawn.rows;
    list.replaceChildren(...drawn.children);
  }

  // VS Code may take a hidden panel down; the saved choices bring it back as it was.
  function save(): void {
    context.state.set({ connection: data.connection, focus: data.focus, table, metric, axis, selected });
  }

  function markSelection(): void {
    markRows(rows, selected);
    chart?.update(chartOption());
    detail.replaceChildren(
      ...detailChildren({ steps, selected, table, metric, scope: growthScopeLabel(choices, table) }, ask),
    );
    save();
  }

  function select(id: number): void {
    selected = id;
    markSelection();
  }

  function drawView(): void {
    theme = readTheme();
    steps = seriesOf(data, growthModelOf(data), table);
    cards.replaceChildren(cardGrid(growthCards(steps, metric), () => ''));
    notes.replaceChildren(...noteChildren(data, steps));
    drawGrowth();
    drawList();
    markSelection();
  }

  return {
    show(next) {
      data = next;
      choices = growthTableChoices(next, growthModelOf(next));
      const kept = restoreGrowthChoices(context.state.get(), next);
      table = kept ? kept.table : choices.find(({ id }) => id === next.focus)?.id;
      metric = kept?.metric ?? 'rows';
      axis = kept?.axis ?? 'snapshot';
      selected = kept?.selected;
      const header = pageHeader(context, {
        title: `Growth${scopeSuffix(next.scope)}`,
        subtitle: subtitle(next),
        refresh: 'Read the snapshots again; the choices stay',
        view: (): GrowthMarkdownView => ({ table, metric }),
      });
      const bar = filters(
        { choices, table, metric, axis },
        {
          onTable(chosen) {
            table = chosen;
            drawView();
          },
          onMetric(chosen) {
            metric = chosen;
            drawView();
          },
          onAxis(chosen) {
            axis = chosen;
            drawView();
          },
        },
      );
      const main = el('main');
      main.append(...(next.snapshots.length > 0 ? [bar] : []), cards, notes, growth, list, detail);
      context.app.replaceChildren(header.element, main);
      drawView();
      header.settle();
    },
    redraw() {
      if (data) {
        drawView();
      }
    },
    resize() {
      chart?.resize();
    },
  };
}

export const growthPage: PageKind<GrowthData> = {
  type: 'growth',
  isMessage: isGrowthMessage,
  create: createGrowthPage,
};
