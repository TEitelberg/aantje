/// <reference lib="dom" />
import { housePalette } from './house-colors';
import type { ReportPalette } from './house-colors';
import { chartTheme, modeOf, readPalette } from './palette';
import type { ColorMode } from './palette';
import type { Severity } from './model';

/** The colours of the current VS Code theme, read when a page is built. */
export interface Theme {
  readonly mode: ColorMode;
  /** The background, text, lines and font of the theme, and the colours of aantje on its background. */
  readonly palette: ReportPalette;
  readonly chart: Record<string, unknown>;
}

export function readTheme(): Theme {
  const mode = modeOf(document.body.className);
  const palette = housePalette(readPalette(getComputedStyle(document.body), mode), mode);
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
