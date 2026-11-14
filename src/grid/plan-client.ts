/// <reference lib="dom" />
// The second script of the results page (`dist/plan-client.js`): it draws the plans of Explain and Analysis and the
// charts of a profile with ECharts. It is apart from grid-client.js because ECharts writes its tooltips as markup,
// which the grid script never does; plan-chart.ts and profile-charts.ts escape the tooltip text with html-escape.ts.
import { drawPlan } from './plan-chart';
import { drawFlame, drawOperators } from './profile-charts';

declare global {
  interface Window {
    /** Set by plan-client.js on the results page; the grid script draws a chart only when it is there. */
    aantjePlan?: {
      readonly drawPlan: typeof drawPlan;
      readonly drawFlame: typeof drawFlame;
      readonly drawOperators: typeof drawOperators;
    };
  }
}

window.aantjePlan = { drawPlan, drawFlame, drawOperators };
