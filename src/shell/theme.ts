/// <reference lib="dom" />
import { chartTheme, modeOf, readPalette } from './palette';
import type { ColorMode, Palette } from './palette';
import type { Severity } from './model';

/** The colours of the current VS Code theme, read when a page is built. */
export interface Theme {
  readonly mode: ColorMode;
  readonly palette: Palette;
  readonly chart: Record<string, unknown>;
}

export function readTheme(): Theme {
  const mode = modeOf(document.body.className);
  const palette = readPalette(getComputedStyle(document.body), mode);
  return { mode, palette, chart: chartTheme(palette, mode) };
}

/** The colour of a card or a bar by its severity, the same on every report page. */
export const severityColor =
  (theme: Theme) =>
  (severity: Severity): string =>
    severity === 'error'
      ? theme.palette.error
      : severity === 'warning'
        ? theme.palette.warning
        : theme.palette.series[0];
