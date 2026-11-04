import { describe, expect, it } from 'vitest';
import { FALLBACK } from '../../src/shell/palette';
import { storageTablesOption } from '../../src/storage-report/chart-options';
import type { BarEntry } from '../../src/storage-report/model';
import { barEntries } from '../../src/storage-report/model';
import { sampleStorage } from './storage-support';

const palette = FALLBACK.dark;
const entries = barEntries({ ...sampleStorage(), tableCount: 5 });

type Formatter = (params: unknown) => string;
const tooltipOf = (option: Record<string, unknown>): Formatter =>
  (option.tooltip as { formatter: Formatter }).formatter;
const colors = (option: Record<string, unknown>): string[] =>
  (option.series as { data: { itemStyle: { color: string } }[] }[])[0]?.data.map(
    (datum) => datum.itemStyle.color,
  ) ?? [];

describe('tablesOption', () => {
  const option = storageTablesOption(entries, palette, undefined);

  it('draws the size of each table as a bar, largest on top, with the name of the table as its label', () => {
    expect(option.yAxis).toMatchObject({
      type: 'category',
      inverse: true,
      data: ['shop.events ⚠', 'shop.customers', 'shop.notes', '2 more tables'],
    });
    expect(option.series).toMatchObject([
      {
        type: 'bar',
        data: [{ value: 6 * 1024 * 1024 }, { value: 2 * 1024 * 1024 }, { value: 0 }, { value: 0 }],
      },
    ]);
  });

  it('colours a table with many small files, an ordinary table and the bar of the others differently', () => {
    expect(colors(option)).toEqual([palette.warning, palette.series[0], palette.series[0], palette.lines]);
  });

  it('colours the selected table in the second series colour, also when it has many small files', () => {
    expect(colors(storageTablesOption(entries, palette, 2))[1]).toBe(palette.series[1]);
    expect(colors(storageTablesOption(entries, palette, 1))[0]).toBe(palette.series[1]);
    expect(colors(storageTablesOption(entries, palette, 99))).toEqual(colors(option));
  });

  it('describes a bar in the tooltip with its table, bytes and files', () => {
    expect(tooltipOf(option)([{ dataIndex: 0 }])).toBe(
      '<b>shop.events ⚠</b><br>6 MB<br>10 files, 1,200 rows, many small files',
    );
    expect(tooltipOf(option)([{ dataIndex: 3 }])).toBe('<b>2 more tables</b><br>0 B<br>together');
    expect(tooltipOf(option)([{ dataIndex: 99 }])).toBe('');
  });

  it('escapes the name of a table in the tooltip', () => {
    const hostile: BarEntry = {
      label: '<img src=x onerror=1>',
      sizeBytes: 1,
      detail: '<b>',
      tableId: 1,
      manySmallFiles: false,
    };
    expect(tooltipOf(storageTablesOption([hostile], palette, undefined))([{ dataIndex: 0 }])).toBe(
      '<b>&lt;img src=x onerror=1&gt;</b><br>1 B<br>&lt;b&gt;',
    );
  });

  it('does not animate, because the page redraws on every theme change, and keeps the tooltip inside the page', () => {
    expect(option.animation).toBe(false);
    expect(option.tooltip).toMatchObject({ confine: true });
  });
});
