/// <reference lib="dom" />
// Colours of the plan and profile charts: a thin layer over shell/palette.ts, so that they get the contrast checks and
// the fallbacks of each kind of theme that the report charts get.
import { contrastRatio, modeOf, parseColor, readPalette, toHex } from '../shell/palette';
import type { Palette } from '../shell/palette';
import type { OperatorKind } from './plan';

/**
 * The theme variable and its fallback for each kind of operator. One table for the squares of the Statistics table
 * (GRID_CSS) and for the flame graph, the treemap and the bars, so that a kind has the same colour everywhere.
 */
export const KIND_VARIABLES: Readonly<Record<OperatorKind, readonly [string, string]>> = {
  scan: ['--vscode-charts-blue', '#3794ff'],
  join: ['--vscode-charts-yellow', '#cca700'],
  aggregate: ['--vscode-charts-orange', '#d18616'],
  cte: ['--vscode-charts-green', '#89d185'],
  union: ['--vscode-descriptionForeground', '#8b8b8b'],
  filter: ['--vscode-charts-purple', '#b180d7'],
  sort: ['--vscode-charts-purple', '#b180d7'],
  window: ['--vscode-charts-purple', '#b180d7'],
  limit: ['--vscode-descriptionForeground', '#8b8b8b'],
  projection: ['--vscode-descriptionForeground', '#8b8b8b'],
  other: ['--vscode-descriptionForeground', '#8b8b8b'],
};

/** `share` of `color` over `base`: a tint that keeps the theme's text readable. */
export function tint(color: string, base: string, share: number): string {
  const under = parseColor(base);
  const over = under && parseColor(color, under);
  if (!under || !over) return base;
  const mixed = over.map((value, index) => Math.round(value * share + (under[index] ?? 0) * (1 - share)));
  return `rgb(${mixed.join(', ')})`;
}

// White text needs this contrast on a fill (WCAG 2.1 for large text and graphics); below it dark text reads better.
const LABEL_CONTRAST = 3;
const WHITE = [255, 255, 255] as const;

/** White or dark text, whichever reads better on `color`, which may be see-through over `background`. */
export function readableOn(color: string, background: string): string {
  const fill = parseColor(color, parseColor(background));
  return fill && contrastRatio(fill, WHITE) < LABEL_CONTRAST ? '#1e1e1e' : '#ffffff';
}

export interface ChartColors {
  /** Background, foreground, series, warning (orange), error (red) and font, as the report charts read them. */
  readonly palette: Palette;
  /** The editor's text colour while it is readable, else the foreground: the text of the plan's tiles. */
  readonly editorForeground: string;
  /** Secondary text: the theme's description colour while it is readable, else the foreground. */
  readonly muted: string;
  /** Axis lines and the borders between areas. */
  readonly border: string;
  /** The editor font, in which the plan measures and draws its tiles. */
  readonly editorFont: string;
  readonly kinds: Readonly<Record<OperatorKind, string>>;
}

// WCAG 2.1 AA for text, as in shell/palette.ts.
const TEXT_CONTRAST = 4.5;

/** The colours of the current theme, read once for a drawing. */
export function chartColors(): ChartColors {
  const style = getComputedStyle(document.body);
  const palette = readPalette(style, modeOf(document.body.className));
  const read = (name: string): string => style.getPropertyValue(name).trim();
  const background = parseColor(palette.background) ?? [0, 0, 0];
  const readable = (name: string): string => {
    const color = parseColor(read(name), background);
    return color && contrastRatio(color, background) >= TEXT_CONTRAST ? toHex(color) : palette.foreground;
  };
  const border = parseColor(read('--vscode-panel-border'), background);
  const kinds = Object.fromEntries(
    Object.entries(KIND_VARIABLES).map(([kind, [variable, fallback]]) => [kind, read(variable) || fallback]),
  ) as Record<OperatorKind, string>;
  return {
    palette,
    editorForeground: readable('--vscode-editor-foreground'),
    muted: readable('--vscode-descriptionForeground'),
    border: border ? toHex(border) : palette.lines,
    editorFont: read('--vscode-editor-font-family') || 'monospace',
    kinds,
  };
}
