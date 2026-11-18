/// <reference lib="dom" />
// The second script of the results page (`dist/plan-client.js`): it draws the plans of Explain and Analysis, the
// charts of a profile and the charts of a result with ECharts. It is apart from grid-client.js because ECharts writes
// its tooltips as markup, which the grid script never does; plan-chart.ts, profile-charts.ts and
// result-chart-option.ts escape the tooltip text with html-escape.ts.
import { drawPlan } from './plan-chart';
import { drawFlame } from './profile-charts';
import { drawResultChart } from './result-chart-draw';

declare global {
  interface Window {
    /** Set by plan-client.js on the results page; the grid script draws a chart only when it is there. */
    aantjePlan?: {
      readonly drawPlan: typeof drawPlan;
      readonly drawFlame: typeof drawFlame;
      readonly drawResultChart: typeof drawResultChart;
    };
  }
}

window.aantjePlan = { drawPlan, drawFlame, drawResultChart };
