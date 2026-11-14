/// <reference lib="dom" />
// Browser side of the snapshot report: state and events; the DOM is built in render.ts.
import { focusPane, markPicked, note, pageHeader } from '../shell/blocks';
import type { ListRow } from '../shell/blocks';
import { el } from '../shell/dom';
import { isHighContrast } from '../shell/palette';
import { boundsOf, fitRange } from '../shell/range-state';
import { reportPage } from '../shell/report-page';
import { readTheme } from '../shell/theme';
import type { Theme } from '../shell/theme';
import type { SnapshotActionRequest } from '../snapshot-changes/actions';
import { POINT_KINDS, buildModel, detailOf } from '../snapshot-changes/model';
import type { Model } from '../snapshot-changes/model';
import { windowSubtitle } from '../snapshot-changes/window';
import { snapshotReportOption } from './chart-options';
import { omittedLanesNote, snapshotReportOlderNote, snapshotReportViewOf } from './model';
import type { SnapshotReportData, SnapshotReportView } from './model';
import type { SnapshotReportMarkdownView } from './markdown';
import { isSnapshotReportMessage } from './protocol';
import { chartHeight, columnAt, detailChildren, emptyPlot, snapshotList, toolbar } from './render';
import type { Choices } from './render';
import { restoreState } from './state';

/** Keeps the choices when the same connection is read again. */
export const snapshotReportPage = reportPage<SnapshotReportData>(
  'snapshotReport',
  isSnapshotReportMessage,
  ({ context, charts, mount }) => {
    let data: SnapshotReportData;
    let model: Model;
    let choices: Choices;
    let selected: number | undefined;
    let other: number | undefined;
    let view: SnapshotReportView;
    let theme: Theme;
    let rows = new Map<number, ListRow>();

    const notes = el('div', 'notes');
    const plot = el('div', 'plot');
    const detail = focusPane('detail');
    const list = el('section', 'list');

    const ask = (request: SnapshotActionRequest): void => context.post({ type: 'action', ...request });

    const chartOption = () =>
      snapshotReportOption(
        {
          view,
          axis: choices.axis,
          detail: (id: number) => detailOf(model, data.latest, id),
          selected,
          other,
          contrast: isHighContrast(theme.mode),
        },
        theme.palette,
      );

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
      charts.clear();
      theme = readTheme();
      if (view.columns.length === 0) {
        plot.replaceChildren(emptyPlot(data.snapshots.length));
        return;
      }
      plot.replaceChildren(
        charts.box(chartOption(), {
          height: chartHeight(view.lanes.length),
          onPlotClick: (x, extend) => {
            const id = columnAt(view, choices.axis, x);
            if (id !== undefined) {
              select(id, extend);
            }
          },
        }),
      );
      charts.drawAll(theme);
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
        charts.charts[0]?.update(chartOption());
      }
      markPicked(rows, selected, other);
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
          range: kept?.range ?? fitRange(undefined, boundsOf(model.snapshots)),
          axis: kept?.axis ?? 'order',
        };
        selected = kept?.selected;
        other = kept?.other;
        const header = pageHeader(context, {
          title: 'Snapshot report',
          subtitle: windowSubtitle(next),
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
        mount(header, main);
        drawView();
      },
      redraw: drawPlot,
    };
  },
);
