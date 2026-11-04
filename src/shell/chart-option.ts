import { escapeHtml } from '../html-escape';

/** An ECharts option; only the shape that the builders produce matters to the page. */
export type ChartOption = Record<string, unknown>;

/** The pixel height of a bar chart: a row per bar plus the axis. */
export const barChartHeight = (bars: number): number => Math.max(160, bars * 24 + 48);

/** The index of the first data point in an axis tooltip. */
export const firstIndex = (params: unknown): number =>
  (params as readonly { readonly dataIndex: number }[])[0]?.dataIndex ?? 0;

/** A tooltip as HTML without `style` attributes (the page allows no inline styles). Title first; text is escaped. */
export function tip(title: string, lines: readonly string[]): string {
  return [`<b>${escapeHtml(title)}</b>`, ...lines.map(escapeHtml)].join('<br>');
}
