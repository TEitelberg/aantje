/// <reference lib="dom" />
// The statistics of the columns in the header of a grid (grid-client.js): a row below the names and filters with, for
// each column, a histogram and lines of a label and a value; the toggle in the toolbar; and the line between the toolbar
// and the grid that says where the computing stands. DuckDB computes the figures in the extension; the page computes
// nothing over the rows. Every name and value is written as text, the histograms as SVG elements.
import { el } from '../shell/dom';
import type { Shape } from '../shell/svg-icon';
import { count } from '../shell/numbers';
import type { GridColumn } from '../data/types';
import { coverLine, cutNotice, facts, summaryMarkdown } from './column-summary';
import type { Bin, ColumnStats, ColumnSummary, SummaryState } from './column-summary';
import type { HostPort } from './grid-view';
import { toolIconButton } from './render';

/** What the statistics ask of their grid and of the extension. */
export interface StatisticsHooks {
  readonly columns: readonly GridColumn[];
  /** Asks the extension for the statistics. */
  readonly ask: () => void;
  /** The statistics were shown, hidden or computed: the header changed, and so did the context menu. */
  readonly changed: () => void;
  /** The rows that were read of a result that was cut; its notice stands in the line above the grid. */
  readonly cut?: number;
}

export interface ColumnStatistics {
  /** The toggle of the toolbar, pressed while the statistics are shown. */
  readonly toggle: HTMLButtonElement;
  /** The line between the toolbar and the grid, while the statistics are shown. */
  readonly line: HTMLElement;
  /** The row of the header with the statistics of each column, once DuckDB computed them. */
  readonly row: HTMLTableRowElement;
  /** Once the grid is on the page: statistics that are shown and not computed yet are asked for. */
  readonly placed: () => void;
  readonly receive: (state: SummaryState) => void;
  /** Whether the header shows the row of the statistics. */
  readonly showing: () => boolean;
  /** The statistics as Markdown while the header shows them, else undefined. */
  readonly markdown: () => string | undefined;
}

// Shown or hidden on this page; the extension remembers it for the next page.
let shown: boolean | undefined;

const SVG = 'http://www.w3.org/2000/svg';
const BAR_HEIGHT = 28;

// Three bars on a line: a histogram.
const STATISTICS_ICON: readonly Shape[] = [
  ['path', { d: 'M1 14.5h14' }],
  ['rect', { x: '2.5', y: '9.5', width: '3', height: '5' }],
  ['rect', { x: '6.5', y: '2.5', width: '3', height: '12' }],
  ['rect', { x: '10.5', y: '6.5', width: '3', height: '8' }],
];

/** The bars of a histogram as an inline picture; each bar has its bound and count as a title. */
function histogramPicture(bins: readonly Bin[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  const most = Math.max(1, ...bins.map((bin) => bin.count));
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', `0 0 ${bins.length * 10} ${BAR_HEIGHT}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Histogram of ${bins.length} bars`);
  bins.forEach((bin, index) => {
    const height = bin.count === 0 ? 0 : Math.max(1, (bin.count / most) * BAR_HEIGHT);
    const rect = document.createElementNS(SVG, 'rect');
    rect.setAttribute('x', String(index * 10 + 1));
    rect.setAttribute('width', '8');
    rect.setAttribute('y', String(BAR_HEIGHT - height));
    rect.setAttribute('height', String(height));
    const title = document.createElementNS(SVG, 'title');
    title.textContent = `up to ${bin.upper}: ${count(bin.count)} rows`;
    rect.append(title);
    svg.append(rect);
  });
  return svg;
}

/**
 * The cell of a column: the histogram, or as much empty space, so that the lines of all columns line up; then a line
 * for each figure, the label first, the value cut in the width of the column.
 */
function statisticsCell(stats: ColumnStats | undefined, rows: number): HTMLTableCellElement {
  const cell = el('td', 'stat');
  const bins = stats?.histogram ?? [];
  cell.append(bins.length > 0 ? histogramPicture(bins) : el('div', 'spark'));
  const list = el('dl', 'facts');
  for (const { label, value } of stats ? facts(stats, rows) : []) {
    list.append(el('dt', undefined, label), el('dd', 'cut', value));
  }
  cell.append(list);
  return cell;
}

function button(text: string, title: string, run: () => void): HTMLButtonElement {
  const made = el('button', undefined, text);
  made.title = title;
  made.addEventListener('click', run);
  return made;
}

/** The statistics of the columns of a grid, shown or hidden as the page or the extension last had them. */
export function columnStatistics(host: HostPort, hooks: StatisticsHooks): ColumnStatistics {
  shown ??= host.settings().statistics === true;
  let state: SummaryState | undefined;
  const toggle = toolIconButton(
    STATISTICS_ICON,
    'Column Statistics',
    'show or hide the statistics of each column above it, computed by DuckDB',
  );
  toggle.className = 'tool-icon statistics-toggle';
  // The warning colour of a cut result, else the quiet one.
  const line = el('div', hooks.cut === undefined ? 'stats-line' : 'stats-line banner');
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  const row = el('tr', 'stats');
  // The second row of the header, while it is shown; a right-click on it offers to copy the statistics.
  row.setAttribute('aria-rowindex', '2');
  row.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'statistics' }));
  // What the header showed last: the grid hears only of a change.
  let drawn: ColumnSummary | undefined;

  const ask = (): void => {
    state = { status: 'running' };
    render();
    hooks.ask();
  };
  // A failed computing can be tried again; a computed one says only what it covers.
  const again = (): HTMLButtonElement =>
    button('Compute again', 'Ask DuckDB for the statistics of the columns again', ask);
  const done = (): ColumnSummary | undefined =>
    shown && state?.status === 'done' ? state.summary : undefined;
  const { cut } = hooks;
  const cutSpan = (): HTMLElement[] => (cut === undefined ? [] : [el('span', 'cover', cutNotice(cut))]);

  /**
   * The one line above the grid: the cut of a result (always, while there is one), and while the statistics are shown
   * the state of their computing, merged with the cut into one message once they are computed.
   */
  function lineChildren(): HTMLElement[] {
    if (!shown || state === undefined) return cutSpan();
    switch (state.status) {
      case 'running':
        return [
          ...cutSpan(),
          el('span', 'cover', 'DuckDB computes the statistics of the columns...'),
          button('Cancel', 'Stop computing the statistics', () => host.post({ type: 'cancelCompute' })),
        ];
      case 'failed':
        return [...cutSpan(), el('span', 'cover', state.message), again()];
      case 'done':
        return [el('span', 'cover', coverLine(state.summary.cover, cut))];
    }
  }

  /** Shows the state; the grid hears when the row of the header comes, goes or shows other figures. */
  function render(): void {
    toggle.setAttribute('aria-pressed', String(shown));
    const children = lineChildren();
    line.hidden = children.length === 0;
    line.replaceChildren(...children);
    const summary = done();
    if (summary === drawn) return;
    drawn = summary;
    row.hidden = summary === undefined;
    if (summary) {
      row.replaceChildren(
        el('td', 'rn'),
        ...hooks.columns.map((_, index) => statisticsCell(summary.columns[index], summary.cover.rows)),
      );
    }
    hooks.changed();
  }

  toggle.addEventListener('click', () => {
    shown = !shown;
    host.post({ type: 'statistics', shown });
    // Nothing is computed while the statistics are hidden.
    if (shown && state === undefined) ask();
    else render();
  });
  // Built with only the cut: nothing to tell the grid, which is being built.
  toggle.setAttribute('aria-pressed', String(shown));
  line.replaceChildren(...cutSpan());
  line.hidden = cut === undefined;
  row.hidden = true;
  return {
    toggle,
    line,
    row,
    // Another grid of the page may have shown or hidden the statistics meanwhile.
    placed: () => {
      if (shown && state === undefined) ask();
      else render();
    },
    receive: (next) => {
      state = next;
      render();
    },
    showing: () => done() !== undefined,
    markdown: () => {
      const summary = done();
      return summary && summaryMarkdown(summary);
    },
  };
}
