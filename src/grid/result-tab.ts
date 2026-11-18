/// <reference lib="dom" />
// What every view of the results page and the grid has in common, and the one way a chart tab is drawn.
import type { SummaryState } from './column-summary';
import type { GridRequest, MenuCopy, RowsFormat } from './protocol';

/** What the extension asks of a grid. */
export interface GridRequests {
  /** The statistics of the columns, which the extension computed. */
  summary(state: SummaryState): void;
  /** A copy that the context menu of the grid chose. */
  copy(what: MenuCopy): void;
  /** The rows shown, saved in the format that Export as File chose. */
  exportAs(format: RowsFormat): void;
}

/** A view on the page: its DOM, what to do once it is on the page, and what to free when it goes. */
export interface ResultTab {
  readonly elements: HTMLElement[];
  /** Measures and draws what needs the space on the page, e.g. the rows of a grid or a chart. */
  readonly placed: () => void;
  readonly dispose?: () => void;
  /** The grid of the view, for what the extension asks of it. */
  readonly grid?: GridRequests;
}

/** Hands a request of the extension to the grid that it names. */
export function handOver(grid: GridRequests | undefined, request: GridRequest): void {
  if (request.type === 'menuCopy') grid?.copy(request.what);
  else grid?.exportAs(request.format);
}

/** A chart that plan-client.js drew. */
export interface ChartHandle {
  /** Fits the drawing to the space it has now. */
  resize(): void;
  dispose(): void;
}

/**
 * A tab whose chart is drawn into `host` once the tab is on the page, and fitted again when `host` changes size.
 * `draw` returns nothing when plan-client.js is not on the page (only the results page loads it, see plan-client.ts):
 * then `fallback` fills `host` instead.
 */
export function lazyChartTab(
  view: HTMLElement,
  host: HTMLElement,
  draw: (host: HTMLElement) => ChartHandle | undefined,
  fallback: () => HTMLElement[],
): ResultTab {
  let chart: ChartHandle | undefined;
  const observer = new ResizeObserver(() => chart?.resize());
  observer.observe(host);
  return {
    elements: [view],
    placed: () => {
      chart ??= draw(host);
      if (!chart) {
        host.replaceChildren(...fallback());
        return;
      }
      chart.resize();
    },
    dispose: () => {
      observer.disconnect();
      chart?.dispose();
    },
  };
}
