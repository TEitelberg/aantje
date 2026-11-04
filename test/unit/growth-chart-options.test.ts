import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { growthOption } from '../../src/growth/chart-options';
import { growthModelOf, seriesOf } from '../../src/growth/model';
import type { GrowthData, Step } from '../../src/growth/model';
import { FALLBACK } from '../../src/shell/palette';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { historyGrowth } from './growth-support';

const palette = FALLBACK.dark;
const catalogs = editedCatalogs();
afterAll(() => catalogs.dispose());

interface Datum {
  value: number | [number, number];
  symbol: string;
  symbolSize: number;
}

interface Option {
  tooltip: { formatter(params: unknown): string };
  xAxis: { type: string; data?: string[] };
  series: { data: Datum[] }[];
}

let data: GrowthData;
let customers: Step[];
beforeAll(async () => {
  data = await historyGrowth(catalogs, { authors: [[40, 44, 'ann', 'Backfill']] });
  customers = seriesOf(data, growthModelOf(data), HISTORY_ID.customers);
});

const chart = (extra: Partial<Parameters<typeof growthOption>[0]> = {}): Option =>
  growthOption(
    {
      steps: customers,
      metric: 'rows',
      axis: 'snapshot',
      scope: 'shop.customers',
      contrast: false,
      ...extra,
    },
    palette,
  ) as unknown as Option;

const at = (index: number) => [{ dataIndex: index }];

describe('the line chart of the growth', () => {
  it('draws a point for every snapshot with the right value, hollow when it is not exact, larger when selected, and on the time axis', () => {
    const option = chart();
    const points = option.series[0]?.data ?? [];
    expect(points.map(({ value }) => value)).toEqual(customers.map((step) => step.total.rows));
    expect(option.xAxis.data).toEqual(customers.map((step) => `@${step.id}`));
    const symbolOf = (id: number) => points[customers.findIndex((step) => step.id === id)]?.symbol;
    expect([symbolOf(16), symbolOf(17), symbolOf(30)]).toEqual(['circle', 'emptyCircle', 'none']);

    const index = customers.findIndex((step) => step.id === 30);
    const picked = chart({ selected: 30 }).series[0]?.data ?? [];
    expect(picked[index]?.symbol).toBe('circle');
    expect(picked[index]?.symbolSize).toBeGreaterThan(points[index]?.symbolSize ?? 0);

    const timed = chart({ axis: 'time' });
    expect(timed.xAxis.type).toBe('time');
    expect(timed.series[0]?.data[16]?.value).toEqual([Date.parse(customers[16]?.time ?? ''), 4]);
    expect(chart({ metric: 'bytes' }).series[0]?.data.at(-1)?.value).toBe(2960);
  });

  it('shows the author, message, value and change in the tooltip, and escapes text from the catalog', () => {
    const index = (id: number) => customers.findIndex((step) => step.id === id);
    const text = chart().tooltip.formatter(at(index(25)));
    expect(text).toContain('@25');
    expect(text).toContain('tillmann');
    expect(chart().tooltip.formatter(at(999))).toBe('');

    const lake = seriesOf(data, growthModelOf(data), undefined);
    const option = growthOption(
      { steps: lake, metric: 'bytes', axis: 'snapshot', scope: 'all tables', contrast: false },
      palette,
    ) as unknown as Option;
    expect(option.tooltip.formatter(at(42))).toContain('ann');

    const hostile: Step[] = customers.slice(0, 2).map((step) => ({
      ...step,
      author: '<img src=x onerror=alert(1)>',
      message: '"><script>1</script> & more',
    }));
    const escaped = chart({ steps: hostile }).tooltip.formatter(at(1));
    expect(escaped).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(escaped).toContain('&quot;&gt;&lt;script&gt;1&lt;/script&gt; &amp; more');
    expect(escaped).not.toMatch(/<(img|script)|style=/);
  });
});
