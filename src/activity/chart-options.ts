import { firstIndex, tip } from '../shell/chart-option';
import type { ChartOption } from '../shell/chart-option';
import { count, plural } from '../shell/model';
import type { Palette } from '../shell/palette';
import { colorOf } from '../snapshot-report/chart-options';
import { SNAPSHOT_REPORT_KIND_LABEL, POINT_KINDS } from '../snapshot-report/model';
import type { Day, TableRow } from './model';

// Animation is off because the page redraws on every theme change; patterns (`aria.decal`) come from the theme.
const base = { animation: false, tooltip: { confine: true } };

const changes = (value: number): string => plural(value, 'change', 'changes');

/** The commits of each day that has any, as bars. */
export function commitsOption(days: readonly Day[], palette: Palette): ChartOption {
  return {
    ...base,
    aria: {
      label: {
        description: `Bar chart of the commits on ${plural(days.length, 'day', 'days')}. The table below has the same information.`,
      },
    },
    tooltip: {
      ...base.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const day = days[firstIndex(params)];
        return day ? tip(day.day, [plural(day.commits, 'commit', 'commits')]) : '';
      },
    },
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: days.map((day) => day.day), axisLabel: { hideOverlap: true } },
    yAxis: { type: 'value', name: 'Commits', minInterval: 1 },
    series: [
      {
        type: 'bar',
        name: 'Commits',
        data: days.map((day) => day.commits),
        itemStyle: { color: palette.series[0] },
      },
    ],
  };
}

/** Changes per day, stacked by kind; high contrast themes tell the kinds apart by pattern. */
export function kindsOption(days: readonly Day[], palette: Palette): ChartOption {
  return {
    ...base,
    aria: {
      label: {
        description: `Stacked bar chart of the changes on ${plural(days.length, 'day', 'days')} by kind of change. The table below has the same information.`,
      },
    },
    tooltip: {
      ...base.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const day = days[firstIndex(params)];
        return day
          ? tip(
              day.day,
              POINT_KINDS.filter((kind) => day.kinds[kind] > 0).map(
                (kind) => `${SNAPSHOT_REPORT_KIND_LABEL[kind]}: ${changes(day.kinds[kind])}`,
              ),
            )
          : '';
      },
    },
    legend: { top: 0, selectedMode: false },
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: days.map((day) => day.day), axisLabel: { hideOverlap: true } },
    yAxis: { type: 'value', name: 'Changes', minInterval: 1 },
    series: POINT_KINDS.map((kind) => ({
      type: 'bar',
      name: SNAPSHOT_REPORT_KIND_LABEL[kind],
      stack: 'kinds',
      data: days.map((day) => day.kinds[kind]),
      itemStyle: { color: colorOf(kind, palette) },
    })),
  };
}

/** The most changed tables, the busiest on top. */
export function activityTablesOption(tables: readonly TableRow[], palette: Palette): ChartOption {
  return {
    ...base,
    aria: {
      label: {
        description: `Bar chart of the ${plural(tables.length, 'most changed table', 'most changed tables')}. The table beside it has the same information.`,
      },
    },
    tooltip: {
      ...base.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const row = tables[firstIndex(params)];
        return row
          ? tip(row.label, [
              changes(row.changes),
              ...POINT_KINDS.filter((kind) => row.kinds[kind] > 0).map(
                (kind) => `${SNAPSHOT_REPORT_KIND_LABEL[kind]}: ${count(row.kinds[kind])}`,
              ),
            ])
          : '';
      },
    },
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', name: 'Changes', minInterval: 1 },
    yAxis: {
      type: 'category',
      inverse: true,
      data: tables.map((row) => row.key),
      axisLabel: {
        width: 240,
        overflow: 'truncate',
        interval: 0,
        formatter: (key: string) => tables.find((row) => row.key === key)?.label ?? '',
      },
    },
    series: [
      {
        type: 'bar',
        name: 'Changes',
        data: tables.map((row) => row.changes),
        itemStyle: { color: palette.series[0] },
      },
    ],
  };
}
