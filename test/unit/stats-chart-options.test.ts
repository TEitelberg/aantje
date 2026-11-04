import { describe, expect, it } from 'vitest';
import type { PartitionStatistics } from '../../src/catalog/model';
import { escapeHtml } from '../../src/html-escape';
import { statisticsGrowthOption, histogramOption, partitionOption } from '../../src/stats/chart-options';
import { FALLBACK } from '../../src/shell/palette';
import { historyStatistics } from './stats-support';

const all = await historyStatistics();
const palette = FALLBACK.dark;

type Formatter = (params: unknown) => string;
const tooltipOf = (option: Record<string, unknown>): Formatter =>
  (option.tooltip as { formatter: Formatter }).formatter;
const at = (dataIndex: number) => [{ dataIndex }];

describe('escapeHtml', () => {
  it('escapes everything that could open a tag or an attribute', () => {
    expect(escapeHtml(`<img src="x" onerror='1'> & more`)).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;1&#39;&gt; &amp; more',
    );
  });
});

describe('histogramOption', () => {
  const option = histogramOption(all.events, palette);

  it('draws the number of files of each size range as a bar in the first series colour', () => {
    expect(option.xAxis).toMatchObject({
      data: [
        '< 11 B',
        '11 B – 21 B',
        '21 B – 42 B',
        '42 B – 83 B',
        '83 B – 166 B',
        '166 B – 332 B',
        '332 B – 664 B',
        '≥ 664 B',
      ],
    });
    expect(option.series).toMatchObject([
      { type: 'bar', name: 'Files', data: [0, 0, 0, 0, 0, 0, 8, 1], itemStyle: { color: '#3794ff' } },
    ]);
    expect(option.yAxis).toMatchObject({ minInterval: 1 });
  });

  it('describes a bar in the tooltip with its range, files and bytes', () => {
    expect(tooltipOf(option)(at(6))).toBe('<b>332 B – 664 B</b><br>8 files, 4.9 KB');
    expect(tooltipOf(option)(at(7))).toBe('<b>≥ 664 B</b><br>1 file, 1.3 KB');
    expect(tooltipOf(option)(at(99))).toBe('');
  });

  it('shows every label of the size ranges and keeps the tooltip inside the page', () => {
    expect((option.xAxis as { axisLabel: unknown }).axisLabel).toEqual({ interval: 0 });
    expect(option.tooltip).toMatchObject({ confine: true });
  });

  it('does not animate, because the page redraws on every theme change', () => {
    expect(option.animation).toBe(false);
  });
});

describe('partitionOption', () => {
  const partitioning = all.events.partitioning as PartitionStatistics;

  it('draws one bar per partition, largest first from the top, with the values of the keys as labels', () => {
    const option = partitionOption(partitioning, palette);
    expect(option.yAxis).toMatchObject({
      type: 'category',
      inverse: true,
      data: ['click / 3', 'click / 4', 'view / 3', 'view / 4'],
    });
    expect(option.series).toMatchObject([
      {
        data: [647, 618, 613, 613].map((value) => ({ value, itemStyle: { color: '#3794ff' } })),
      },
    ]);
    expect(tooltipOf(option)(at(0))).toBe('<b>click / 3</b><br>647 B<br>1 file, 2 rows');
    // the size axis is labelled in bytes units, not in raw numbers
    const format = (option.xAxis as { axisLabel: { formatter: (value: number) => string } }).axisLabel
      .formatter;
    expect(format(2048)).toBe('2 KB');
  });

  it('adds the partitions that are summed up as one bar in the colour of the lines, not in another series colour', () => {
    const option = partitionOption(
      { ...partitioning, rest: { partitions: 7, files: 9, sizeBytes: 5000, rows: 1234 } },
      palette,
    );
    const data =
      (option.series as { data: { value: number; itemStyle: { color: string } }[] }[])[0]?.data ?? [];
    expect(data.map((bar) => bar.itemStyle.color)).toEqual([
      '#3794ff',
      '#3794ff',
      '#3794ff',
      '#3794ff',
      palette.lines,
    ]);
    expect(data.at(-1)?.value).toBe(5000);
    expect((option.yAxis as { data: string[] }).data.at(-1)).toBe('other (7)');
    expect(tooltipOf(option)(at(4))).toBe('<b>other (7)</b><br>4.9 KB<br>7 partitions, 9 files, 1,234 rows');
  });

  it('escapes the values of a partition in the tooltip, which is HTML', () => {
    const [first] = partitioning.partitions;
    const hostile = '<img src=x onerror=alert(1)>';
    const option = partitionOption(
      { ...partitioning, partitions: first ? [{ ...first, values: [hostile, '"q"'] }] : [] },
      palette,
    );
    const html = tooltipOf(option)(at(0));
    expect(html).toBe('<b>&lt;img src=x onerror=alert(1)&gt; / &quot;q&quot;</b><br>647 B<br>1 file, 2 rows');
    expect(html).not.toContain('<img');
  });
});

describe('growthOption', () => {
  const option = statisticsGrowthOption(all.log, palette);

  it('draws size and files as two lines on two axes, in the blue and purple of the theme', () => {
    expect(option.xAxis).toMatchObject({ data: ['@51', '@55', '@56'] });
    expect(option.series).toMatchObject([
      { name: 'Size', itemStyle: { color: '#3794ff' }, lineStyle: { color: '#3794ff' }, step: 'end' },
      { name: 'Files', yAxisIndex: 1, data: [1, 1, 2], itemStyle: { color: '#b180d7' } },
    ]);
    expect(option.yAxis).toHaveLength(2);
  });

  it('marks the compaction with a diamond on the size line and nowhere else', () => {
    const size = (option.series as { data: unknown[] }[])[0]?.data;
    expect(size).toEqual([750, { value: 750, symbol: 'diamond', symbolSize: 14 }, 1081]);
  });

  it('describes a point with its snapshot, time, size and files, and names the compaction', () => {
    expect(tooltipOf(option)(at(1))).toBe(
      '<b>@55 (compaction)</b><br>2026-10-30 12:43:34 UTC<br>750 B<br>1 file',
    );
    expect(tooltipOf(option)(at(2))).toBe('<b>@56</b><br>2026-10-30 12:43:34 UTC<br>1.1 KB<br>2 files');
  });

  it('puts no style attribute into any tooltip, which the content security policy of the page would block', () => {
    const outputs = [
      tooltipOf(histogramOption(all.events, palette))(at(6)),
      tooltipOf(partitionOption(all.events.partitioning as PartitionStatistics, palette))(at(0)),
      tooltipOf(option)(at(1)),
    ];
    expect(outputs.filter((html) => /style\s*=/i.test(html))).toEqual([]);
  });
});
