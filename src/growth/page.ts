/// <reference lib="dom" />
// Browser side of the Growth report: state and events; the DOM is built in render.ts.
import { cardGrid, focusPane, markPicked, pageHeader } from '../shell/blocks';
import type { ListRow } from '../shell/blocks';
import { el } from '../shell/dom';
import { isHighContrast } from '../shell/palette';
import { reportPage } from '../shell/report-page';
import { scopeSuffix } from '../shell/scope';
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
import { detailChildren, filters, growthPane, noteChildren, snapshotList } from './render';
import { restoreGrowthChoices } from './state';

/** Keeps the choices when the same report is read again. */
export const growthPage = reportPage<GrowthData>('growth', isGrowthMessage, ({ context, charts, mount }) => {
  let data: GrowthData;
  let choices: TableChoice[];
  let steps: Step[];
  let theme: Theme;
  let table: number | undefined;
  let metric: Metric = 'rows';
  let axis: GrowthXAxis = 'snapshot';
  let selected: number | undefined;
  let rows = new Map<number, ListRow>();

  const cards = el('div', 'cards-box');
  const notes = el('div', 'notes');
  const growth = el('section', 'growth');
  const list = el('section', 'list');
  const detail = focusPane('detail');

  const ask = (request: GrowthActionRequest): void => context.post({ type: 'action', ...request });

  const chartOption = () =>
    growthOption(
      {
        steps,
        metric,
        axis,
        scope: growthScopeLabel(choices, table),
        selected,
        contrast: isHighContrast(theme.mode),
      },
      theme.palette,
    );

  function drawGrowth(): void {
    charts.clear();
    growth.replaceChildren(
      ...growthPane(
        metric,
        growthScopeLabel(choices, table),
        {
          charts,
          option: chartOption(),
          onItemClick: (index) => {
            const step = steps[index];
            if (step) {
              select(step.id);
            }
          },
        },
        steps.length > 0,
      ),
    );
    charts.drawAll(theme);
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
    markPicked(rows, selected);
    charts.charts[0]?.update(chartOption());
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
      mount(header, main);
      drawView();
    },
    redraw: drawView,
  };
});
