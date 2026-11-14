/// <reference lib="dom" />
import type { ChartOption } from './chart-option';
import { drawChart } from './charts';
import type { Chart } from './charts';
import { el } from './dom';
import type { Theme } from './theme';

interface ChartSpec {
  /**
   * What the chart shows, for assistive technology. ECharts writes the description of the option on the box, with
   * `role="img"`; this label becomes that description. Without it, the option's own description is kept.
   */
  readonly label?: string;
  readonly height?: number;
  /** A click on the plot: the value on the x axis, and whether Ctrl or Cmd was held. */
  readonly onPlotClick?: (x: number, extend: boolean) => void;
  readonly onItemClick?: (index: number) => void;
}

/** The charts of a page: their boxes are drawn once they are in the document, and go away and resize together. */
export interface ChartSet {
  /** A box for the option, drawn by the next `drawAll`. */
  box(option: ChartOption, spec?: ChartSpec): HTMLElement;
  /** Draws the boxes made since the last call; they must be in the document, since ECharts needs their size. */
  drawAll(theme: Theme): void;
  /** The charts drawn, in the order of their boxes. */
  readonly charts: readonly Chart[];
  resize(): void;
  /** Disposes the charts and drops the boxes not drawn yet; call before the page is built again. */
  clear(): void;
}

/** What the builders of a page with charts get: the theme, and the set the boxes are drawn by. */
export interface Frame {
  readonly theme: Theme;
  readonly charts: ChartSet;
}

const described = (option: ChartOption, label: string): ChartOption => ({
  ...option,
  aria: { ...(option.aria as Record<string, unknown> | undefined), label: { description: label } },
});

export function chartSet(): ChartSet {
  let charts: Chart[] = [];
  let pending: { readonly box: HTMLElement; readonly option: ChartOption; readonly spec: ChartSpec }[] = [];
  return {
    box(option, spec = {}) {
      const box = el('div', 'chart');
      if (spec.height !== undefined) {
        box.style.height = `${spec.height}px`;
      }
      pending.push({ box, option: spec.label === undefined ? option : described(option, spec.label), spec });
      return box;
    },
    drawAll(theme) {
      const drawing = pending;
      pending = [];
      for (const { box, option, spec } of drawing) {
        charts.push(drawChart(box, theme.chart, option, spec.onPlotClick, spec.onItemClick));
      }
    },
    get charts() {
      return charts;
    },
    resize() {
      for (const chart of charts) {
        chart.resize();
      }
    },
    clear() {
      for (const chart of charts) {
        chart.dispose();
      }
      charts = [];
      pending = [];
    },
  };
}
