/// <reference lib="dom" />
// Browser side of the Activity report: state and events; the DOM is built in render.ts.
import { POINT_KINDS } from '../snapshot-report/model';
import type { Model, PointKind } from '../snapshot-report/model';
import { boundsOf } from '../shell/range-state';
import { cardGrid, note, pageHeader } from '../shell/blocks';
import { drawChart } from '../shell/charts';
import type { Chart } from '../shell/charts';
import { el } from '../shell/dom';
import { scopeSuffix } from '../shell/scope';
import { plural } from '../shell/model';
import type { Page, PageContext, PageKind } from '../shell/page';
import { readTheme } from '../shell/theme';
import type { Theme } from '../shell/theme';
import type { ActivityActionRequest } from './actions';
import type { ActivityMarkdownView } from './markdown';
import {
  AUTHOR_EXAMPLE,
  AUTHOR_HINT,
  NO_AUTHOR,
  activityCards,
  activityModelOf,
  activityOlderNote,
  summarizeActivity,
} from './model';
import type { ActivityData, ActivitySummary } from './model';
import { isActivityMessage } from './protocol';
import { drawAuthors, drawDays, drawDetail, drawList, drawTables, filterBar } from './render';
import type { ChartIn } from './render';
import { restoreActivityChoices } from './state';

function createActivityPage(context: PageContext): Page<ActivityData> {
  let data: ActivityData;
  let model: Model;
  let summary: ActivitySummary;
  let theme: Theme;
  let charts: Chart[] = [];
  let author: string | undefined;
  let table: string | undefined;
  let kinds = new Set<PointKind>(POINT_KINDS);
  let text = '';
  let range = { from: 0, to: 0 };
  let selected: number | undefined;
  let showTable: ((key: string | undefined) => void) | undefined;
  let rows = new Map<number, { readonly row: HTMLElement; readonly pick: HTMLElement }>();

  const cards = el('div', 'cards-box');
  const notes = el('div', 'notes');
  const days = el('section', 'days');
  const authors = el('section', 'authors');
  const tables = el('section', 'tables-section');
  const detail = el('section', 'detail');
  // The pane is replaced when the selection changes; it takes the focus that the button in it loses.
  detail.tabIndex = -1;
  const list = el('section', 'list');

  const ask = (request: ActivityActionRequest): void => context.post({ type: 'action', ...request });

  const chartIn: ChartIn = (parent, option, height, onItemClick) => {
    const box = el('div', 'chart');
    if (height !== undefined) {
      box.style.height = `${height}px`;
    }
    parent.append(box);
    charts.push(drawChart(box, theme.chart, option, undefined, onItemClick));
  };

  // Keeps the choices: VS Code can take down a hidden panel, which then comes back as it was.
  function save(): void {
    context.state.set({
      connection: data.connection,
      bounds: boundsOf(model.snapshots),
      author,
      table,
      kinds: [...kinds],
      text,
      range,
      selected,
    });
  }

  function markSelection(): void {
    for (const [at, { row, pick }] of rows) {
      row.className = at === selected ? 'selected' : '';
      pick.setAttribute('aria-pressed', String(at === selected));
    }
    drawDetail(detail, { data, model }, selected, ask);
    save();
  }

  function select(id: number): void {
    selected = id;
    markSelection();
  }

  function drawView(): void {
    for (const chart of charts) {
      chart.dispose();
    }
    charts = [];
    theme = readTheme();
    summary = summarizeActivity(model, { author, table, kinds: [...kinds], text, range });
    const view = { data, model, summary, theme };
    cards.replaceChildren(cardGrid(activityCards(summary, data.snapshots.length), () => ''));
    const missing = summary.authors.some((row) => row.author === NO_AUTHOR);
    notes.replaceChildren(
      ...(data.more ? [note(activityOlderNote(data))] : []),
      ...(missing ? [note(`${AUTHOR_HINT} ${AUTHOR_EXAMPLE}`)] : []),
    );
    drawDays(days, view, chartIn);
    drawAuthors(authors, summary);
    drawTables(tables, view, chartIn, (key) => {
      table = key;
      showTable?.(key);
      drawView();
    });
    rows = drawList(list, view, select);
    markSelection();
  }

  function filters(): HTMLElement {
    const bar = filterBar(
      model,
      { author, table, kinds, text, rangeAt: (end) => range[end] },
      {
        onAuthor(key) {
          author = key;
          drawView();
        },
        onTable(key) {
          table = key;
          drawView();
        },
        onText(typed) {
          text = typed;
          drawView();
        },
        onKinds: drawView,
        onRange(end, next) {
          range = { ...range, [end]: next };
          drawView();
        },
      },
    );
    showTable = bar.showTable;
    return bar.element;
  }

  return {
    show(next) {
      data = next;
      model = activityModelOf(next);
      const kept = restoreActivityChoices(context.state.get(), next, model);
      author = kept?.author;
      table = kept?.table;
      kinds = new Set(kept?.kinds ?? POINT_KINDS);
      text = kept?.text ?? '';
      range = kept?.range ?? { from: model.snapshots[0]?.id ?? 0, to: model.snapshots.at(-1)?.id ?? 0 };
      selected = kept?.selected;
      const header = pageHeader(context, {
        title: `Activity${scopeSuffix(next.scope)}`,
        subtitle: `${next.connection} · ${plural(next.snapshots.length, 'snapshot', 'snapshots')} ${next.scope.kind === 'schema' ? 'of the schema' : 'read'}, latest @${next.latest}`,
        refresh: 'Read the snapshots again; the choices stay',
        view: (): ActivityMarkdownView => ({ author, table, kinds: [...kinds], text, range }),
      });
      const main = el('main');
      main.append(
        ...(next.snapshots.length > 0 ? [filters()] : []),
        cards,
        notes,
        days,
        authors,
        tables,
        list,
        detail,
      );
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
      for (const chart of charts) {
        chart.resize();
      }
    },
  };
}

export const activityPage: PageKind<ActivityData> = {
  type: 'activity',
  isMessage: isActivityMessage,
  create: createActivityPage,
};
