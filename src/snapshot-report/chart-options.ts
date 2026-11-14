import type { SnapshotId } from '../catalog/model';
import { tip } from '../shell/chart-option';
import type { ChartOption } from '../shell/chart-option';
import type { Palette } from '../shell/palette';
import { plural, tableLabel, whoText } from '../shell/model';
import { colorOf } from '../snapshot-changes/colors';
import { KIND_LABEL, POINT_KINDS } from '../snapshot-changes/model';
import type { PointKind, SnapshotDetail } from '../snapshot-changes/model';
import type { SnapshotReportView } from './model';

/** One column per snapshot in order, or each snapshot at its time. */
export type SnapshotReportXAxis = 'order' | 'time';

export interface SnapshotReportChart {
  readonly view: SnapshotReportView;
  readonly axis: SnapshotReportXAxis;
  readonly detail: (snapshot: SnapshotId) => SnapshotDetail | undefined;
  readonly selected?: SnapshotId | undefined;
  readonly other?: SnapshotId | undefined;
  /** High contrast theme: outlines, larger marks, solid lines. */
  readonly contrast: boolean;
}

// The shape says what a point is; the colour only repeats it.
const SHAPE: Readonly<Record<PointKind, string>> = {
  insert: 'circle',
  update: 'pin',
  delete: 'triangle',
  ddl: 'diamond',
  maintenance: 'rect',
};

const TOOLTIP_TABLES = 8;

function tooltipOf(detail: SnapshotDetail): string {
  const who = whoText(detail.author, detail.message);
  const tables = detail.tables
    .slice(0, TOOLTIP_TABLES)
    .map((table) => `${table.label}: ${table.actions.join(', ')}`);
  const rest = detail.tables.length - tables.length;
  return tip(`@${detail.id} · ${detail.timeText}`, [
    ...(who === '' ? [] : [who]),
    ...tables,
    ...(rest > 0 ? [`and ${rest} more ${rest === 1 ? 'table' : 'tables'}`] : []),
    ...detail.others.slice(0, TOOLTIP_TABLES),
  ]);
}

interface PointDatum {
  readonly snapshot: SnapshotId;
}

/** The swimlane chart: a lane per table, a mark per changing snapshot, a line through lanes changed together. */
export function snapshotReportOption(chart: SnapshotReportChart, palette: Palette): ChartOption {
  const { view, axis, contrast } = chart;
  const columnOf = new Map(view.columns.map((column, index) => [column.id, index]));
  const x = (snapshot: SnapshotId): number => {
    const index = columnOf.get(snapshot) ?? -1;
    return axis === 'order' ? index : Date.parse(view.columns[index]?.time ?? '');
  };
  const laneIndex = new Map(view.lanes.map((lane, index) => [lane.key, index]));
  const marks = POINT_KINDS.map((kind) => ({
    type: 'scatter',
    name: KIND_LABEL[kind],
    symbol: SHAPE[kind],
    symbolSize: contrast ? 15 : 11,
    z: 3,
    itemStyle: {
      color: colorOf(kind, palette),
      borderColor: palette.foreground,
      borderWidth: contrast ? 1.5 : 0,
    },
    data: view.points
      .filter((point) => point.kind === kind)
      .map((point) => ({ value: [x(point.snapshot), laneIndex.get(point.lane)], snapshot: point.snapshot })),
  }));
  const bottom = view.lanes.length - 0.5;
  const verticals = (snapshots: readonly SnapshotId[]) =>
    snapshots.map((snapshot) => ({
      coords: [
        [x(snapshot), -0.5],
        [x(snapshot), bottom],
      ],
    }));
  const line = (snapshots: readonly SnapshotId[], width: number, type: 'solid' | 'dashed', z: number) => ({
    type: 'lines',
    coordinateSystem: 'cartesian2d',
    silent: true,
    z,
    lineStyle: { color: palette.foreground, width, type, opacity: contrast ? 1 : 0.7 },
    data: verticals(snapshots),
  });
  const marked = (snapshot: SnapshotId | undefined): SnapshotId[] =>
    snapshot !== undefined && columnOf.has(snapshot) ? [snapshot] : [];
  const lanes = view.lanes.map((lane) => (lane.dropped ? `${tableLabel(lane)} (dropped)` : tableLabel(lane)));
  return {
    animation: false,
    aria: {
      label: {
        description: `Swimlane chart of ${plural(view.columns.length, 'snapshot', 'snapshots')} on ${plural(view.lanes.length, 'lane', 'lanes')}. The list below the chart has the same information.`,
      },
    },
    tooltip: {
      trigger: 'item',
      confine: true,
      formatter: (params: unknown) => {
        const datum = (params as { readonly data?: PointDatum }).data;
        const detail = datum && chart.detail(datum.snapshot);
        return detail ? tooltipOf(detail) : '';
      },
    },
    legend: {
      top: 0,
      selectedMode: false,
      data: POINT_KINDS.map((kind) => KIND_LABEL[kind]),
    },
    grid: { left: 8, right: 24, top: 36, bottom: 64, containLabel: true },
    xAxis:
      axis === 'order'
        ? {
            type: 'value',
            min: -0.5,
            max: view.columns.length - 0.5,
            minInterval: 1,
            splitLine: { show: false },
            axisLabel: {
              formatter: (value: number) =>
                Number.isInteger(value) ? `@${view.columns[value]?.id ?? ''}` : '',
            },
          }
        : { type: 'time', splitLine: { show: false } },
    yAxis: {
      type: 'category',
      inverse: true,
      data: view.lanes.map((lane) => lane.key),
      axisLabel: {
        width: 240,
        overflow: 'truncate',
        interval: 0,
        formatter: (key: string) => lanes[laneIndex.get(key) ?? -1] ?? '',
      },
    },
    dataZoom: [
      { type: 'slider', xAxisIndex: 0, filterMode: 'none', height: 24, bottom: 8 },
      { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
    ],
    series: [
      line(view.transactions, contrast ? 2 : 1, 'solid', 1),
      ...marks,
      line(marked(chart.other), 2, 'dashed', 2),
      line(marked(chart.selected), 3, 'solid', 2),
    ],
  };
}
