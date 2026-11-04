import { BarChart, GraphChart, LineChart, LinesChart, ScatterChart } from 'echarts/charts';
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import type { ChartOption } from './chart-option';

// The bundle keeps only what is registered here, since ECharts is large.
echarts.use([
  BarChart,
  GraphChart,
  LineChart,
  LinesChart,
  ScatterChart,
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

/** A chart on the page; a theme change disposes it and draws a new one. */
export interface Chart {
  resize(): void;
  /** Replaces the series; keeps the rest, including the zoom. */
  update(option: ChartOption): void;
  dispose(): void;
}

type PlotClick = (x: number, extend: boolean) => void;

type ItemClick = (index: number) => void;

/**
 * Draws `option` into `element`, which must be in the document and have a size. The item callbacks get the index of a
 * data item; a click on an edge of a graph is not one.
 */
export function drawChart(
  element: HTMLElement,
  theme: Record<string, unknown>,
  option: ChartOption,
  onPlotClick?: PlotClick,
  onItemClick?: ItemClick,
  onItemDoubleClick?: ItemClick,
): Chart {
  const chart = echarts.init(element, theme, { renderer: 'canvas' });
  chart.setOption(option as EChartsCoreOption);
  if (onPlotClick) {
    chart.getZr().on('click', (event) => {
      const at = [event.offsetX, event.offsetY];
      const [x] = chart.convertFromPixel({ gridIndex: 0 }, at);
      if (x !== undefined && chart.containPixel({ gridIndex: 0 }, at)) {
        onPlotClick(x, event.event.ctrlKey || event.event.metaKey);
      }
    });
  }
  for (const [name, onItem] of [
    ['click', onItemClick],
    ['dblclick', onItemDoubleClick],
  ] as const) {
    if (onItem) {
      chart.on(name, (event) => {
        if (event.dataType !== 'edge') onItem(event.dataIndex);
      });
    }
  }
  return {
    resize: () => chart.resize(),
    update: (next) => chart.setOption(next as EChartsCoreOption, { replaceMerge: ['series'] }),
    dispose: () => chart.dispose(),
  };
}
