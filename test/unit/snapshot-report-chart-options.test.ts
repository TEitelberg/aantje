import { beforeAll, describe, expect, it } from 'vitest';
import { snapshotReportOption } from '../../src/snapshot-report/chart-options';
import type { SnapshotReportChart } from '../../src/snapshot-report/chart-options';
import {
  POINT_KINDS,
  buildModel,
  snapshotReportDetailOf,
  snapshotReportViewOf,
} from '../../src/snapshot-report/model';
import type { Model } from '../../src/snapshot-report/model';
import { FALLBACK } from '../../src/shell/palette';
import { HISTORY_ID, HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import { historyReport, snapshot, tableChange } from './snapshot-report-support';

const palette = FALLBACK.dark;
type Series = {
  type: string;
  name?: string;
  symbol?: string;
  symbolSize?: number;
  itemStyle?: { color: string; borderWidth: number };
  lineStyle?: { type: string; width: number };
  data: { value?: unknown[]; snapshot?: number; coords?: number[][] }[];
};
type Option = {
  series: Series[];
  legend: { data: string[]; selectedMode: boolean };
  xAxis: { type: string; max?: number; axisLabel?: { formatter(value: number): string } };
  yAxis: { data: string[]; axisLabel: { formatter(key: string): string } };
  tooltip: { formatter(params: unknown): string };
  dataZoom: { type: string; filterMode: string }[];
  aria: { label: { description: string } };
};

let model: Model;
beforeAll(async () => {
  const data = await historyReport();
  model = buildModel(data.snapshots);
});

function chart(overrides: Partial<SnapshotReportChart> = {}, source: Model = model): SnapshotReportChart {
  return {
    view: snapshotReportViewOf(source, { lanes: [], kinds: POINT_KINDS }),
    axis: 'order',
    detail: (id) => snapshotReportDetailOf(source, HISTORY_LATEST_SNAPSHOT, id),
    contrast: false,
    ...overrides,
  };
}

const option = (overrides: Partial<SnapshotReportChart> = {}, source: Model = model): Option =>
  snapshotReportOption(chart(overrides, source), palette) as unknown as Option;

const kindSeries = (built: Option) => built.series.filter((series) => series.type === 'scatter');

describe('the swimlane chart', () => {
  it('has the points of the fixture on the lane of their table and in the column of their snapshot, with marks for the selected and second one', () => {
    const built = option();
    expect(kindSeries(built).map((series) => series.data.length)).toEqual([18, 2, 2, 35, 1]);
    const { lanes } = snapshotReportViewOf(model, { lanes: [], kinds: POINT_KINDS });
    const lane = (key: string) => lanes.findIndex((candidate) => candidate.key === key);
    const [inserts, , , , maintenance] = kindSeries(built);
    expect(inserts?.data.find((point) => point.snapshot === 6)?.value).toEqual([
      6,
      lane(`t${HISTORY_ID.events}`),
    ]);
    expect(maintenance?.data).toEqual([{ value: [55, lane(`t${HISTORY_ID.log}`)], snapshot: 55 }]);
    expect(built.xAxis).toMatchObject({ type: 'value', max: 56.5 });
    expect(built.yAxis.data).toEqual(lanes.map((entry) => entry.key));
    expect(built.yAxis.data.map((key) => built.yAxis.axisLabel.formatter(key)).slice(0, 3)).toEqual([
      'main.evolved',
      'shop.customers',
      'shop.events',
    ]);

    const timed = option({ axis: 'time' });
    const first = kindSeries(timed)[0]?.data[0];
    expect(timed.xAxis.type).toBe('time');
    expect(first?.value?.[0]).toBe(
      Date.parse(model.snapshots.find((candidate) => candidate.id === first?.snapshot)?.time ?? ''),
    );

    const marked = option({ selected: 23, other: 40 });
    const [transactions, , , , , , second, selected] = marked.series;
    const line = (id: number) => [
      {
        coords: [
          [id, -0.5],
          [id, 8.5],
        ],
      },
    ];
    expect(transactions?.data).toEqual(line(23));
    expect(selected?.data).toEqual(line(23));
    expect(second?.data).toEqual(line(40));
    const none = option({ selected: 999, other: undefined });
    expect(none.series.at(-1)?.data).toEqual([]);
    expect(none.series.at(-2)?.data).toEqual([]);
  });
});

describe('the tooltip of a point', () => {
  const tooltip = (
    snapshotId: number,
    overrides: Partial<SnapshotReportChart> = {},
    source: Model = model,
  ): string => option(overrides, source).tooltip.formatter({ data: { snapshot: snapshotId } });
  const withModel = (source: Model) => ({
    view: snapshotReportViewOf(source, { lanes: [], kinds: POINT_KINDS }),
    detail: (id: number) => snapshotReportDetailOf(source, 1, id),
  });

  it('names the snapshot, its author and message, and what it did to every table, cutting long lists', () => {
    expect(tooltip(25)).toMatch(
      /^<b>@25 · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC<\/b><br>tillmann · Nightly import<br>shop\.customers: Inserted into table$/,
    );
    expect(tooltip(23)).toContain('shop.events');
    expect(tooltip(23)).toContain('shop.customers');

    const wide = buildModel([
      snapshot(
        1,
        Array.from({ length: 10 }, (_, table) => tableChange(table, 'inserted', 'shop', `t${table}`)),
      ),
    ]);
    // Eight tables are listed, the others are counted.
    expect(tooltip(1, withModel(wide), wide).split('<br>')).toHaveLength(1 + 8 + 1);

    const built = option();
    expect(built.tooltip.formatter({ data: { snapshot: 999 } })).toBe('');
    expect(built.tooltip.formatter({})).toBe('');
  });

  it('escapes every name, message and author, and has no attribute that the content security policy would block', () => {
    const hostile = '<img src=x onerror=alert(1)>"\'&';
    const bad = buildModel([
      snapshot(1, [tableChange(3, 'inserted', hostile, hostile)], {
        author: hostile,
        commitMessage: hostile,
      }),
    ]);
    const text = tooltip(1, withModel(bad), bad);
    expect(text).not.toContain('<img');
    expect(text).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;');
    expect(text.replaceAll(/<\/?b>|<br>/g, '')).not.toMatch(/[<>"']/);
    for (const { id } of model.snapshots) {
      expect(tooltip(id), `@${id}`).not.toContain('style=');
    }
  });
});
