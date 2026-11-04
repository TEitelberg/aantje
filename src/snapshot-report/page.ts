/// <reference lib="dom" />
// Browser side of the snapshot report: state and events; the DOM is built in render.ts.
import { note, pageHeader } from '../shell/blocks';
import { drawChart } from '../shell/charts';
import type { Chart } from '../shell/charts';
import { el } from '../shell/dom';
import { plural } from '../shell/model';
import type { Page, PageContext, PageKind } from '../shell/page';
import { isHighContrast } from '../shell/palette';
import { readTheme } from '../shell/theme';
import type { Theme } from '../shell/theme';
import type { SnapshotReportActionRequest } from './actions';
import { snapshotReportOption } from './chart-options';
import {
  POINT_KINDS,
  buildModel,
  omittedLanesNote,
  snapshotReportDetailOf,
  snapshotReportOlderNote,
  snapshotReportViewOf,
} from './model';
import type { Model, SnapshotReportData, SnapshotReportView } from './model';
import type { SnapshotReportMarkdownView } from './markdown';
import { isSnapshotReportMessage } from './protocol';
import { chartBox, columnAt, detailChildren, emptyPlot, markRows, snapshotList, toolbar } from './render';
import type { Choices, ListRow } from './render';
import { boundsOf } from '../shell/range-state';
import { restoreState } from './state';

/** Keeps the choices when the same connection is read again. */
function createSnapshotReportPage(context: PageContext): Page<SnapshotReportData> {
  let data: SnapshotReportData;
  let model: Model;
  let choices: Choices;
  let selected: number | undefined;
  let other: number | undefined;
  let view: SnapshotReportView;
  let theme: Theme;
  let chart: Chart | undefined;
  let rows = new Map<number, ListRow>();

  const notes = el('div', 'notes');
  const plot = el('div', 'plot');
  const detail = el('section', 'detail');
  // The pane is replaced when a choice changes; it takes the focus that the button in it loses.
  detail.tabIndex = -1;
  const list = el('section', 'list');

  const ask = (request: SnapshotReportActionRequest): void => context.post({ type: 'action', ...request });

  const chartInput = () => ({
    view,
    axis: choices.axis,
    detail: (id: number) => snapshotReportDetailOf(model, data.latest, id),
    selected,
    other,
    contrast: isHighContrast(theme.mode),
  });

  /** A plain click selects a snapshot; Ctrl-click picks or releases the second snapshot of a comparison. */
  function select(id: number, extend: boolean): void {
    if (extend && selected !== undefined && id !== selected) {
      other = other === id ? undefined : id;
    } else {
      selected = id;
      if (other === id) {
        other = undefined;
      }
    }
    drawSelection();
  }

  function drawPlot(): void {
    chart?.dispose();
    chart = undefined;
    theme = readTheme();
    if (view.columns.length === 0) {
      plot.replaceChildren(emptyPlot(data.snapshots.length));
      return;
    }
    const box = chartBox(view.lanes.length);
    plot.replaceChildren(box);
    chart = drawChart(box, theme.chart, snapshotReportOption(chartInput(), theme.palette), (x, extend) => {
      const id = columnAt(view, choices.axis, x);
      if (id !== undefined) {
        select(id, extend);
      }
    });
  }

  function drawList(): void {
    const drawn = snapshotList(view, model, data.latest, select);
    rows = drawn.rows;
    list.replaceChildren(...drawn.children);
  }

  // VS Code may take a hidden panel down; the saved choices bring it back as it was.
  function save(): void {
    context.state.set({
      connection: data.connection,
      bounds: boundsOf(model.snapshots),
      lanes: [...choices.lanes],
      kinds: [...choices.kinds],
      range: choices.range,
      axis: choices.axis,
      selected,
      other,
    });
  }

  function drawSelection(updateChart = true): void {
    detail.replaceChildren(
      ...detailChildren(
        { model, latest: data.latest, selected, other },
        {
          onAction: ask,
          onClearOther() {
            other = undefined;
            drawSelection();
            detail.focus();
          },
        },
      ),
    );
    if (updateChart) {
      chart?.update(snapshotReportOption(chartInput(), theme.palette));
    }
    markRows(rows, selected, other);
    save();
  }

  function drawView(): void {
    view = snapshotReportViewOf(model, {
      lanes: [...choices.lanes],
      kinds: [...choices.kinds],
      range: choices.range,
    });
    notes.replaceChildren(
      ...(data.more ? [note(snapshotReportOlderNote(data))] : []),
      ...(view.omittedLanes > 0 ? [note(omittedLanesNote(view.omittedLanes), 'warning')] : []),
    );
    drawPlot();
    drawList();
    drawSelection(false);
  }

  return {
    show(next) {
      data = next;
      model = buildModel(next.snapshots, next.more);
      const kept = restoreState(context.state.get(), next, model);
      choices = {
        lanes: new Set(kept?.lanes),
        kinds: new Set(kept ? kept.kinds : POINT_KINDS),
        range: kept?.range ?? { from: model.snapshots[0]?.id ?? 0, to: model.snapshots.at(-1)?.id ?? 0 },
        axis: kept?.axis ?? 'order',
      };
      selected = kept?.selected;
      other = kept?.other;
      const header = pageHeader(context, {
        title: 'Snapshot report',
        subtitle: `${next.connection} · ${plural(next.snapshots.length, 'snapshot', 'snapshots')} read, latest @${next.latest}`,
        refresh: 'Read the snapshots again; the choices stay',
        view: (): SnapshotReportMarkdownView => ({
          lanes: [...choices.lanes],
          kinds: [...choices.kinds],
          range: choices.range,
        }),
      });
      const bar = toolbar(model, () => choices, {
        onChange(change) {
          choices = change;
          drawView();
        },
        onAction: ask,
      });
      const main = el('main');
      main.append(...(next.snapshots.length > 0 ? [bar] : []), notes, plot, detail, list);
      context.app.replaceChildren(header.element, main);
      drawView();
      header.settle();
    },
    redraw() {
      if (data) {
        drawPlot();
      }
    },
    resize() {
      chart?.resize();
    },
  };
}

export const snapshotReportPage: PageKind<SnapshotReportData> = {
  type: 'snapshotReport',
  isMessage: isSnapshotReportMessage,
  create: createSnapshotReportPage,
};
