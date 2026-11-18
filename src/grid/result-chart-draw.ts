/// <reference lib="dom" />
// Draws the chart of a result with the shell's ECharts (plan-client.js): the colours of aantje on the background of the
// theme, the theme's colours in high contrast (shell/house-colors.ts, as the reports). ECharts keeps only the kinds of
// chart that are registered.
import { BoxplotChart, HeatmapChart, PieChart } from 'echarts/charts';
import { CalendarComponent, VisualMapComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { drawChart } from '../shell/charts';
import { readTheme } from '../shell/theme';
import { prepareChart } from './chart-data';
import type { ChartAdvice } from './chart-values';
import type { ChartChoice } from './result-chart';
import { minimumHeight, resultChartOption } from './result-chart-option';
import type { GridColumn, GridValue } from '../data/types';

echarts.use([BoxplotChart, HeatmapChart, PieChart, CalendarComponent, VisualMapComponent]);

/** The rows and the choice of a chart. */
export interface ResultChartInput {
  readonly columns: readonly GridColumn[];
  readonly rows: readonly (readonly GridValue[])[];
  readonly choice: ChartChoice;
}

/** A drawn chart of a result. */
export interface ResultChart {
  resize(): void;
  dispose(): void;
  /** The drawing as PNG bytes in base64, on the background of the theme. */
  png(): string;
}

/** Draws into `host`, which is on the page; the advice instead when the chart would not be readable. */
export function drawResultChart(
  host: HTMLElement,
  input: ResultChartInput,
): { readonly chart?: ResultChart; readonly advice?: ChartAdvice } {
  const prepared = prepareChart(input.columns, input.rows, input.choice);
  if (!('kind' in prepared)) {
    host.replaceChildren();
    return { advice: prepared };
  }
  const { palette, chart: base } = readTheme();
  // The theme of the reports styles category and value axes; a time axis gets the same, so its labels are readable.
  const theme = { ...base, timeAxis: base.valueAxis };
  const box = document.createElement('div');
  box.className = 'result-chart';
  box.style.minHeight = `${minimumHeight(prepared)}px`;
  host.replaceChildren(box);
  const option = resultChartOption(prepared, {
    colors: palette,
    foreground: palette.foreground,
    lines: palette.lines,
    background: palette.background,
  });
  const chart = drawChart(box, theme, option);
  return {
    chart: {
      resize: () => chart.resize(),
      dispose: () => chart.dispose(),
      png: () => chart.image(palette.background).replace(/^data:image\/png;base64,/, ''),
    },
  };
}
