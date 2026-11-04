import { describe, expect, it } from 'vitest';
import { barChartHeight, firstIndex } from '../../src/shell/chart-option';

describe('the index of an axis tooltip', () => {
  it('is the data index of the first entry', () => {
    expect(firstIndex([{ dataIndex: 4 }, { dataIndex: 9 }])).toBe(4);
  });

  it('is the first bar when ECharts gives no entry or no index', () => {
    expect(firstIndex([])).toBe(0);
    expect(firstIndex([{}])).toBe(0);
  });
});

describe('the height of a bar chart', () => {
  it('gives each bar a row of 24 pixels and the axis 48 on top', () => {
    expect([barChartHeight(10), barChartHeight(30)]).toEqual([288, 768]);
  });

  it('is never lower than 160 pixels, so that a chart of one bar still has its axis', () => {
    expect([barChartHeight(0), barChartHeight(1), barChartHeight(4)]).toEqual([160, 160, 160]);
    expect(barChartHeight(5)).toBe(168);
  });
});
