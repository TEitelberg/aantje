import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `drawChart` needs a canvas, so every other test stands in for it. This one replaces ECharts itself and checks what
 * `drawChart` asks of it: the click handler, which turns a pixel into the value under the pointer, and the update
 * that keeps the zoom.
 */

type ClickEvent = { offsetX: number; offsetY: number; event: { ctrlKey: boolean; metaKey: boolean } };
type ItemEvent = { dataIndex: number };

const state = vi.hoisted(() => ({
  clicks: [] as ((event: ClickEvent) => void)[],
  itemClicks: [] as ((event: ItemEvent) => void)[],
  setOption: [] as [unknown, unknown][],
  contained: true,
  converted: [12] as (number | undefined)[],
  resized: 0,
  disposed: 0,
  initialised: [] as unknown[],
}));

vi.mock('echarts/core', () => ({
  use: () => undefined,
  init: (element: unknown, theme: unknown, options: unknown) => {
    state.initialised.push([element, theme, options]);
    return {
      setOption: (option: unknown, settings?: unknown) => void state.setOption.push([option, settings]),
      on: (type: string, handler: (event: ItemEvent) => void) => {
        if (type === 'click') state.itemClicks.push(handler);
      },
      getZr: () => ({
        on: (type: string, handler: (event: ClickEvent) => void) => {
          if (type === 'click') state.clicks.push(handler);
        },
      }),
      convertFromPixel: () => state.converted,
      containPixel: () => state.contained,
      resize: () => void state.resized++,
      dispose: () => void state.disposed++,
    };
  },
}));

const { drawChart } = await import('../../src/shell/charts');

const click = (ctrlKey = false, metaKey = false): ClickEvent => ({
  offsetX: 5,
  offsetY: 6,
  event: { ctrlKey, metaKey },
});
const element = {} as HTMLElement;
const theme = { color: ['#fff'] };

beforeEach(() => {
  state.clicks.length = 0;
  state.itemClicks.length = 0;
  state.setOption.length = 0;
  state.contained = true;
  state.converted = [12];
  state.resized = 0;
  state.disposed = 0;
  state.initialised.length = 0;
});

describe('drawChart', () => {
  it('draws the option with the canvas renderer and the theme it is given', () => {
    drawChart(element, theme, { animation: false });
    expect(state.initialised).toEqual([[element, theme, { renderer: 'canvas' }]]);
    expect(state.setOption).toEqual([[{ animation: false }, undefined]]);
  });

  it('tells a click inside the plot with the x value under the pointer, and whether Ctrl or Cmd was held', () => {
    const seen: [number, boolean][] = [];
    drawChart(element, theme, {}, (x, extend) => seen.push([x, extend]));

    state.clicks[0]?.(click());
    state.clicks[0]?.(click(true));
    state.clicks[0]?.(click(false, true));

    expect(seen).toEqual([
      [12, false],
      [12, true],
      [12, true],
    ]);
  });

  it('ignores a click outside the plot, and one that has no x value', () => {
    const seen: number[] = [];
    drawChart(element, theme, {}, (x) => seen.push(x));

    state.contained = false;
    state.clicks[0]?.(click());
    state.contained = true;
    state.converted = [undefined];
    state.clicks[0]?.(click());

    expect(seen).toEqual([]);
  });

  it('listens to no click when there is no handler', () => {
    drawChart(element, theme, {});
    expect(state.clicks).toEqual([]);
    expect(state.itemClicks).toEqual([]);
  });

  it('tells the index of the datum that a click on a bar or a point hit', () => {
    const seen: number[] = [];
    drawChart(element, theme, {}, undefined, (index) => seen.push(index));

    state.itemClicks[0]?.({ dataIndex: 3 });
    state.itemClicks[0]?.({ dataIndex: 0 });

    expect(seen).toEqual([3, 0]);
    expect(state.clicks).toEqual([]);
  });

  it('replaces only the series on an update, so that the zoom of the axis stays', () => {
    const chart = drawChart(element, theme, { first: true });
    chart.update({ second: true });
    expect(state.setOption.at(-1)).toEqual([{ second: true }, { replaceMerge: ['series'] }]);
  });

  it('resizes and disposes the chart it drew', () => {
    const chart = drawChart(element, theme, {});
    chart.resize();
    chart.dispose();
    expect([state.resized, state.disposed]).toEqual([1, 1]);
  });
});
