// Chart colours. ECharts paints on a canvas and needs literal colours, not CSS variables, so the page reads
// the VS Code theme once and builds a chart theme from it. Pure: the page passes the computed style and body class.

/** `hc` and `hc-light` are the two high contrast themes of VS Code. */
export type ColorMode = 'dark' | 'light' | 'hc' | 'hc-light';

export interface Palette {
  readonly background: string;
  readonly foreground: string;
  readonly lines: string;
  /** Blue, green, purple, yellow: ordinary series, in use order. */
  readonly series: readonly [string, string, string, string];
  /** Orange: a value above a threshold (many small files, uneven partitions, many NULLs). */
  readonly warning: string;
  /** Red: an extreme (a column that is all NULL). */
  readonly error: string;
  readonly fontFamily: string;
  readonly fontSize: number;
}

const CLASS_TO_MODE: readonly (readonly [string, ColorMode])[] = [
  ['vscode-high-contrast-light', 'hc-light'],
  ['vscode-high-contrast', 'hc'],
  ['vscode-light', 'light'],
];

/** The mode from the body class list (`vscode-dark`, `vscode-light`, `vscode-high-contrast`, ...). */
export function modeOf(classNames: string): ColorMode {
  const classes = classNames.split(/\s+/);
  return CLASS_TO_MODE.find(([name]) => classes.includes(name))?.[1] ?? 'dark';
}

type Rgb = readonly [number, number, number];

const toHex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

/** Parses `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` into an opaque colour (laid over `background`); else undefined. */
export function parseColor(text: string, background: Rgb = [0, 0, 0]): Rgb | undefined {
  const value = text.trim().toLowerCase();
  let channels: number[] | undefined;
  let alpha = 1;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)?.[1];
  if (hex) {
    const digits = hex.length <= 4 ? Array.from(hex, (digit) => digit + digit) : (hex.match(/../g) ?? []);
    const [r, g, b, a] = digits.map((digit) => parseInt(digit, 16));
    channels = [r ?? 0, g ?? 0, b ?? 0];
    alpha = a === undefined ? 1 : a / 255;
  } else {
    const parts = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(
      value,
    );
    if (parts) {
      channels = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      if (parts[4] !== undefined) {
        alpha = parts[5] ? Number(parts[4]) / 100 : Number(parts[4]);
      }
    }
  }
  if (!channels || channels.some((channel) => !Number.isFinite(channel) || channel > 255) || alpha > 1) {
    return undefined;
  }
  const [r = 0, g = 0, b = 0] = channels;
  return [
    r * alpha + background[0] * (1 - alpha),
    g * alpha + background[1] * (1 - alpha),
    b * alpha + background[2] * (1 - alpha),
  ];
}

function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The WCAG contrast ratio of two opaque colours: 1 (identical) up to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

// WCAG 2.1 AA: text 4.5:1, chart marks 3:1.
const TEXT_CONTRAST = 4.5;
const GRAPHIC_CONTRAST = 3;

/** Colours for a theme that gives none or an invisible one: the chart defaults of the four built-in themes. */
export const FALLBACK: Readonly<Record<ColorMode, Palette>> = {
  dark: {
    background: '#1e1e1e',
    foreground: '#cccccc',
    lines: '#cccccc',
    series: ['#3794ff', '#89d185', '#b180d7', '#cca700'],
    warning: '#d18616',
    error: '#f14c4c',
    fontFamily: 'sans-serif',
    fontSize: 13,
  },
  light: {
    background: '#ffffff',
    foreground: '#616161',
    lines: '#616161',
    series: ['#1a85ff', '#388a34', '#652d90', '#bf8803'],
    warning: '#b86e00',
    error: '#e51400',
    fontFamily: 'sans-serif',
    fontSize: 13,
  },
  hc: {
    background: '#000000',
    foreground: '#ffffff',
    lines: '#ffffff',
    series: ['#3794ff', '#73c991', '#c586c0', '#ffd700'],
    warning: '#ff9d3d',
    error: '#f48771',
    fontFamily: 'sans-serif',
    fontSize: 13,
  },
  'hc-light': {
    background: '#ffffff',
    foreground: '#292929',
    lines: '#292929',
    series: ['#0f4a85', '#374e06', '#652d90', '#895503'],
    warning: '#8a4b00',
    error: '#b5200d',
    fontFamily: 'sans-serif',
    fontSize: 13,
  },
};

const VARIABLES = {
  background: '--vscode-editor-background',
  foreground: '--vscode-charts-foreground',
  lines: '--vscode-charts-lines',
  blue: '--vscode-charts-blue',
  green: '--vscode-charts-green',
  purple: '--vscode-charts-purple',
  yellow: '--vscode-charts-yellow',
  orange: '--vscode-charts-orange',
  red: '--vscode-charts-red',
  fontFamily: '--vscode-font-family',
  fontSize: '--vscode-font-size',
} as const;

/** The palette of the current theme; a missing, unreadable or low-contrast colour falls back to the mode's palette. */
export function readPalette(style: { getPropertyValue(name: string): string }, mode: ColorMode): Palette {
  const fallback = FALLBACK[mode];
  const read = (name: string): string => style.getPropertyValue(name).trim();
  const background = parseColor(read(VARIABLES.background)) ?? parseColor(fallback.background) ?? [0, 0, 0];
  const pick = (variable: string, backup: string, minimum: number): string => {
    const color = parseColor(read(variable), background);
    return color && contrastRatio(color, background) >= minimum ? toHex(color) : backup;
  };
  const fontSize = Number.parseFloat(read(VARIABLES.fontSize));
  return {
    background: toHex(background),
    foreground: pick(VARIABLES.foreground, fallback.foreground, TEXT_CONTRAST),
    // Grid lines are faint on purpose, so they meet no contrast minimum.
    lines: toHex(parseColor(read(VARIABLES.lines), background) ?? (parseColor(fallback.lines) as Rgb)),
    series: [
      pick(VARIABLES.blue, fallback.series[0], GRAPHIC_CONTRAST),
      pick(VARIABLES.green, fallback.series[1], GRAPHIC_CONTRAST),
      pick(VARIABLES.purple, fallback.series[2], GRAPHIC_CONTRAST),
      pick(VARIABLES.yellow, fallback.series[3], GRAPHIC_CONTRAST),
    ],
    warning: pick(VARIABLES.orange, fallback.warning, GRAPHIC_CONTRAST),
    error: pick(VARIABLES.red, fallback.error, GRAPHIC_CONTRAST),
    fontFamily: read(VARIABLES.fontFamily) || fallback.fontFamily,
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : fallback.fontSize,
  };
}

function withAlpha(color: string, alpha: number): string {
  const [r = 0, g = 0, b = 0] = parseColor(color) ?? [0, 0, 0];
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

export const isHighContrast = (mode: ColorMode): boolean => mode === 'hc' || mode === 'hc-light';

/** The ECharts theme; high contrast adds solid grid lines, outlines, larger markers and patterns (`aria.decal`). */
export function chartTheme(palette: Palette, mode: ColorMode): Record<string, unknown> {
  const contrast = isHighContrast(mode);
  const grid = contrast ? palette.foreground : withAlpha(palette.lines, mode === 'light' ? 0.5 : 0.25);
  const axis = {
    axisLine: { lineStyle: { color: contrast ? palette.foreground : withAlpha(palette.lines, 0.6) } },
    axisTick: { lineStyle: { color: contrast ? palette.foreground : withAlpha(palette.lines, 0.6) } },
    axisLabel: { color: palette.foreground },
    splitLine: { lineStyle: { color: grid } },
  };
  return {
    color: [...palette.series],
    backgroundColor: 'transparent',
    textStyle: { color: palette.foreground, fontFamily: palette.fontFamily, fontSize: palette.fontSize },
    categoryAxis: axis,
    valueAxis: axis,
    legend: { textStyle: { color: palette.foreground } },
    tooltip: {
      backgroundColor: palette.background,
      borderColor: contrast ? palette.foreground : withAlpha(palette.lines, 0.6),
      borderWidth: contrast ? 2 : 1,
      textStyle: { color: palette.foreground },
    },
    bar: { itemStyle: { borderColor: palette.foreground, borderWidth: contrast ? 1.5 : 0 } },
    line: { lineStyle: { width: contrast ? 3 : 2 }, symbolSize: contrast ? 9 : 6 },
    aria: { enabled: true, decal: { show: contrast } },
  };
}
