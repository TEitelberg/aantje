import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitsOption, kindsOption, activityTablesOption } from '../../src/activity/chart-options';
import { activityModelOf, summarizeActivity } from '../../src/activity/model';
import type { ActivitySummary } from '../../src/activity/model';
import { colorOf } from '../../src/snapshot-report/chart-options';
import { SNAPSHOT_REPORT_KIND_LABEL, POINT_KINDS } from '../../src/snapshot-report/model';
import { FALLBACK } from '../../src/shell/palette';
import { editedCatalogs } from '../support/edited-catalog';
import { historyActivity } from './activity-support';
import { snapshot, tableChange } from './snapshot-report-support';

const palette = FALLBACK.dark;
const catalogs = editedCatalogs();
afterAll(() => catalogs.dispose());

interface Option {
  aria: { label: { description: string } };
  tooltip: { formatter(params: unknown): string };
  legend?: { selectedMode: boolean };
  xAxis: { data?: string[] };
  yAxis: { data?: string[]; axisLabel?: { formatter(key: string): string } };
  series: { type: string; name: string; stack?: string; data: number[]; itemStyle: { color: string } }[];
}

let summary: ActivitySummary;
beforeAll(async () => {
  summary = summarizeActivity(activityModelOf(await historyActivity(catalogs)), {
    kinds: POINT_KINDS,
    text: '',
  });
});

const at = (index: number) => [{ dataIndex: index }];

describe('the bar chart of the commits per day', () => {
  it('draws one bar for each day with commits, in the order of the days, and says so for assistive technology', () => {
    const option = commitsOption(summary.days, palette) as unknown as Option;
    expect(option.xAxis.data).toEqual([
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
    expect(option.series).toHaveLength(1);
    expect(option.series[0]).toMatchObject({ type: 'bar', name: 'Commits', data: [10, 10, 10, 10, 10, 7] });
    expect(option.series[0]?.itemStyle.color).toBe(palette.series[0]);
    expect(option.aria.label.description).toBe(
      'Bar chart of the commits on 6 days. The table below has the same information.',
    );
  });

  it('says in the tooltip which day and how many commits, and singular and plural right', () => {
    const option = commitsOption(summary.days, palette) as unknown as Option;
    expect(option.tooltip.formatter(at(5))).toBe('<b>2026-10-25</b><br>7 commits');
    expect(option.tooltip.formatter(at(99))).toBe('');
    const one = commitsOption([{ ...summary.days[0], commits: 1 } as never], palette) as unknown as Option;
    expect(one.tooltip.formatter(at(0))).toBe('<b>2026-10-20</b><br>1 commit');
    expect(one.aria.label.description).toContain('on 1 day.');
  });
});

describe('the stacked bar chart of the changes by kind', () => {
  it('stacks one series per kind in the colours of the kinds, with a legend that names them', () => {
    const option = kindsOption(summary.days, palette) as unknown as Option;
    expect(option.series.map(({ name, stack, type }) => [name, stack, type])).toEqual(
      POINT_KINDS.map((kind) => [SNAPSHOT_REPORT_KIND_LABEL[kind], 'kinds', 'bar']),
    );
    expect(option.series.map(({ data }) => data)).toEqual([
      [3, 3, 5, 1, 1, 5],
      [0, 1, 1, 0, 0, 0],
      [0, 1, 1, 0, 0, 0],
      [7, 5, 4, 9, 9, 1],
      [0, 0, 0, 0, 0, 1],
    ]);
    expect(option.series.map(({ itemStyle }) => itemStyle.color)).toEqual(
      POINT_KINDS.map((kind) => colorOf(kind, palette)),
    );
    expect(option.legend?.selectedMode).toBe(false);
  });

  it('lists in the tooltip the kinds that the day has, and nothing for a day it does not have', () => {
    const option = kindsOption(summary.days, palette) as unknown as Option;
    expect(option.tooltip.formatter(at(1))).toBe(
      '<b>2026-10-21</b><br>Insert: 3 changes<br>Update: 1 change<br>Delete: 1 change<br>Schema change: 5 changes',
    );
    expect(option.tooltip.formatter(at(5))).toContain('Maintenance: 1 change');
    expect(option.tooltip.formatter(at(99))).toBe('');
  });
});

describe('the bar chart of the most changed tables', () => {
  it('puts the busiest table on top, keyed by the lane so that two tables of one name stay apart', () => {
    const option = activityTablesOption(summary.tables, palette) as unknown as Option;
    expect(option.yAxis.data?.slice(0, 3)).toEqual(['t12', 't9', 't3']);
    expect(option.series[0]?.data.slice(0, 3)).toEqual([11, 8, 8]);
    expect(option.yAxis.axisLabel?.formatter('t15')).toBe('shop.old_stuff (dropped)');
    expect(option.yAxis.axisLabel?.formatter('t999')).toBe('');
    expect(option.tooltip.formatter(at(0))).toBe(
      '<b>main.evolved</b><br>11 changes<br>Insert: 2<br>Schema change: 9',
    );
    expect(option.aria.label.description).toBe(
      'Bar chart of the 8 most changed tables. The table beside it has the same information.',
    );
  });

  it('escapes names from the catalog in the tooltip', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const own = summarizeActivity(
      activityModelOf({
        connection: 'x',
        scope: { kind: 'lake' },
        latest: 1,
        more: false,
        snapshots: [snapshot(1, [tableChange(7, 'inserted', hostile, hostile)])],
      }),
      { kinds: POINT_KINDS, text: '' },
    );
    const tip = (activityTablesOption(own.tables, palette) as unknown as Option).tooltip.formatter(at(0));
    expect(tip).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(tip).not.toContain('<img');
  });
});

describe('the axes of the charts', () => {
  it('count commits and changes in whole numbers, and draw the most changed table at the top', () => {
    const commits = commitsOption(summary.days, palette) as unknown as { yAxis: { minInterval: number } };
    const kinds = kindsOption(summary.days, palette) as unknown as { yAxis: { minInterval: number } };
    const tables = activityTablesOption(summary.tables, palette) as unknown as {
      xAxis: { minInterval: number };
      yAxis: { inverse: boolean };
    };

    expect([commits.yAxis.minInterval, kinds.yAxis.minInterval, tables.xAxis.minInterval]).toEqual([1, 1, 1]);
    expect(tables.yAxis.inverse).toBe(true);
  });
});
