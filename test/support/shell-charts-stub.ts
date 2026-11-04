// Stands in for src/shell/charts.ts in the tests of the page client: the real module needs a canvas, which the
// DOM stand-in does not have. It records what the client asks to be drawn; the sandbox of the test provides `drawn`.
declare const drawn: {
  element: unknown;
  theme: Record<string, unknown>;
  option: Record<string, unknown>;
  onPlotClick: ((x: number, extend: boolean) => void) | undefined;
  onItemClick: ((index: number) => void) | undefined;
  onItemDoubleClick: ((index: number) => void) | undefined;
  disposed: boolean;
  resized: number;
  updates: Record<string, unknown>[];
}[];

export interface Chart {
  resize(): void;
  update(option: Record<string, unknown>): void;
  dispose(): void;
}

export function drawChart(
  element: unknown,
  theme: Record<string, unknown>,
  option: Record<string, unknown>,
  onPlotClick?: (x: number, extend: boolean) => void,
  onItemClick?: (index: number) => void,
  onItemDoubleClick?: (index: number) => void,
): Chart {
  const entry: (typeof drawn)[number] = {
    element,
    theme,
    option,
    onPlotClick,
    onItemClick,
    onItemDoubleClick,
    disposed: false,
    resized: 0,
    updates: [],
  };
  drawn.push(entry);
  return {
    resize: () => void entry.resized++,
    update: (next) => void entry.updates.push(next),
    dispose: () => void (entry.disposed = true),
  };
}
