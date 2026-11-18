// The colours of aantje, read from the logo (media/logo.png): navy (the duck), orange (the beak) and slate (the slabs),
// and the colours that match them. One scheme for every page: the charts and marks of the reports, the charts of a
// result and the statistics of the columns. Pure: the page passes the palette that it read from the theme.
import { contrastRatio, isHighContrast, parseColor, toHex } from './palette';
import type { ColorMode, Palette, Rgb } from './palette';

/** The three colours of the logo. */
export const HOUSE = { navy: '#0c243f', slate: '#384f70', orange: '#ff8301' } as const;

/** One colour per series, the first four always there. */
export type Series = readonly [string, string, string, string, ...string[]];

/**
 * The series on a light background, in this order: the logo's navy and slate as they are, the beak's orange one step
 * darker (as it is, it has 2.5:1 on white), then the matching colours teal, gold, purple, brick, sky, green, cerulean,
 * rose and tan. Each has 3:1 at least on white. The order keeps neighbours apart, also for readers with a red-green
 * colour vision deficiency (checked with the method of the data visualisation guide: the distance of neighbours in
 * OKLab, normal and simulated).
 */
export const LIGHT_SERIES = [
  HOUSE.navy,
  '#bb5a00',
  HOUSE.slate,
  '#008c85',
  '#8f7400',
  '#7c50a8',
  '#af3e30',
  '#3786c3',
  '#3b8841',
  '#017d9f',
  '#b73f6e',
  '#99651e',
] as const satisfies Series;

/**
 * The same colours on a dark background: navy and slate get lighter steps (as they are they nearly vanish on a dark
 * editor), the orange of the beak stays, the others are steps of their hue for a dark background, in the same order.
 * Each has 3:1 at least on #1e1e1e.
 */
export const DARK_SERIES = [
  '#5a91d7',
  HOUSE.orange,
  '#a9bcd8',
  '#16a7a3',
  '#ce9c20',
  '#9d71cc',
  '#d95c4b',
  '#2c7fb1',
  '#54a859',
  '#389fc3',
  '#d35985',
  '#b98749',
] as const satisfies Series;

/** The colours of the scheme that are not series. */
export interface HouseRoles {
  /** In sync, healthy. */
  readonly ok: string;
  /** A value above a threshold (many small files, uneven partitions, many NULLs). */
  readonly warning: string;
  /** An extreme or a broken thing (a column that is all NULL, a missing object). */
  readonly error: string;
  /** A note that is neither good nor bad. */
  readonly info: string;
  /** What is there but not in focus: the rest of a list, maintenance, a neutral mark. */
  readonly muted: string;
  /** Orange: the selected or pressed thing, and what a page marks for attention. */
  readonly accent: string;
  /** Text and icons on the accent. */
  readonly onAccent: string;
}

/**
 * The roles on a light background. Ok, error and info have 4.5:1 on white, so they also do as text. The warning marks
 * only (borders, bars; a warning in words keeps the theme's colour): a lighter amber, so that it stays apart from the
 * orange of the accent, also for readers with a red-green colour vision deficiency. The accent is the orange of the
 * series, with white text at 4.5:1.
 */
export const LIGHT_ROLES: HouseRoles = {
  ok: '#27762f',
  warning: '#b08505',
  error: '#c22826',
  info: '#1666aa',
  muted: '#7d8796',
  accent: LIGHT_SERIES[1],
  onAccent: '#ffffff',
};

/**
 * The roles on a dark background, lighter steps: the severities have 4.5:1 on #1e1e1e; the accent is the orange of the
 * beak with navy text on it.
 */
export const DARK_ROLES: HouseRoles = {
  ok: '#6bc670',
  warning: '#eebc4a',
  error: '#f3625d',
  info: '#67aaed',
  muted: '#717b89',
  accent: HOUSE.orange,
  onAccent: HOUSE.navy,
};

// WCAG 2.1 AA for graphics: a bar, a line or a border needs 3:1 against the background.
const GRAPHIC_CONTRAST = 3;
const STEPS = 20;

/** `share` of `color` over `background`. */
function mix(color: string, background: string, share: number): string {
  const under = parseColor(background) ?? [0, 0, 0];
  const over = parseColor(color, under) ?? under;
  return toHex(
    over.map((value, index) => value * share + (under[index] ?? 0) * (1 - share)) as unknown as Rgb,
  );
}

/**
 * `color` mixed towards white on a dark background, towards black on a light one, in steps, until it has `minimum`
 * contrast on `background`: for a theme whose background is neither white nor the usual dark grey.
 */
export function withContrast(color: string, background: string, minimum = GRAPHIC_CONTRAST): string {
  const under = parseColor(background) ?? [0, 0, 0];
  const start = parseColor(color, under) ?? under;
  const dark = contrastRatio(under, [0, 0, 0]) < contrastRatio(under, [255, 255, 255]);
  const target: Rgb = dark ? [255, 255, 255] : [0, 0, 0];
  for (let step = 0; step <= STEPS; step++) {
    const share = step / STEPS;
    const hex = toHex(
      [0, 1, 2].map(
        (channel) => (start[channel] ?? 0) * (1 - share) + (target[channel] ?? 0) * share,
      ) as unknown as Rgb,
    );
    // Measured after rounding to the colour that is drawn.
    if (contrastRatio(parseColor(hex) ?? target, under) >= minimum) return hex;
  }
  return toHex(target);
}

/** The shares of the strongest colour in the steps of a ramp, over the background. */
const RAMP_SHARES = [0.12, 0.34, 0.56, 0.78, 1] as const;

/** The colours of aantje on the background of a theme. */
export interface HouseColors extends HouseRoles {
  /** One colour per series, in this order. */
  readonly series: Series;
  /** From the lowest to the highest value of a heatmap or an intensity: one hue, from a faint tint to the first series. */
  readonly ramp: readonly [string, string, ...string[]];
}

/**
 * The scheme on the background of the theme, each colour but the ramp with 3:1 at least: a dark theme starts from the
 * dark lists, a light one from the light lists. In high contrast the theme's own colours win: its series, orange and
 * red, its green for what is fine and selected, its lines for what is muted.
 */
export function houseColors(palette: Palette, mode: ColorMode): HouseColors {
  if (isHighContrast(mode)) {
    const [blue, green] = palette.series;
    return {
      series: [...palette.series, palette.warning, palette.error],
      ramp: [palette.background, blue],
      ok: green,
      warning: palette.warning,
      error: palette.error,
      info: blue,
      muted: palette.lines,
      accent: green,
      onAccent: palette.background,
    };
  }
  const [base, roles] = mode === 'light' ? [LIGHT_SERIES, LIGHT_ROLES] : [DARK_SERIES, DARK_ROLES];
  const fit = (color: string): string => withContrast(color, palette.background);
  const series = base.map(fit) as unknown as Series;
  const strong = series[0];
  return {
    series,
    ramp: RAMP_SHARES.map((share) =>
      mix(strong, palette.background, share),
    ) as unknown as HouseColors['ramp'],
    ok: fit(roles.ok),
    warning: fit(roles.warning),
    error: fit(roles.error),
    info: fit(roles.info),
    muted: fit(roles.muted),
    accent: fit(roles.accent),
    onAccent: roles.onAccent,
  };
}

/** The palette of a report: the background, text, lines and font of the theme, the colours of aantje on it. */
export interface ReportPalette extends Palette, HouseColors {
  readonly series: Series;
}

export function housePalette(palette: Palette, mode: ColorMode): ReportPalette {
  return { ...palette, ...houseColors(palette, mode) };
}

/** The colours of the scheme as CSS custom properties, the value of each for one kind of theme. */
function variables(series: readonly string[], roles: Record<string, string>): string {
  return [
    ...series.map((color, index) => `--aantje-series-${index + 1}: ${color};`),
    ...Object.entries(roles).map(([name, value]) => `--aantje-${name}: ${value};`),
  ].join(' ');
}

const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

function staticVariables(series: Series, roles: HouseRoles, background: string): string {
  const named = Object.fromEntries(Object.entries(roles).map(([name, value]) => [kebab(name), value]));
  return variables(series, {
    navy: series[0],
    orange: roles.accent,
    slate: series[2],
    ...named,
    selected: roles.accent,
    'on-selected': roles.onAccent,
    // The main action of a page (e.g. Run of the health check) in the lighter blue of the logo, the slate; its
    // text as on the accent: white on the light slate step, navy on the dark one.
    primary: series[2],
    'on-primary': roles.onAccent,
    ...Object.fromEntries(
      RAMP_SHARES.map((share, index) => [`ramp-${index + 1}`, mix(series[0], background, share)]),
    ),
  });
}

// In high contrast the variables name the theme's colours: the chart colours for the series and severities, the
// active border for the accent, the button for a pressed control.
const CONTRAST_SERIES = ['blue', 'green', 'purple', 'yellow', 'orange', 'red'].map(
  (name) => `var(--vscode-charts-${name})`,
);
const CONTRAST_VARIABLES = variables(
  Array.from(
    { length: LIGHT_SERIES.length },
    (_, index) => CONTRAST_SERIES[index % CONTRAST_SERIES.length] ?? '',
  ),
  {
    navy: 'var(--vscode-charts-blue)',
    orange: 'var(--vscode-charts-orange)',
    slate: 'var(--vscode-charts-purple)',
    ok: 'var(--vscode-charts-green)',
    warning: 'var(--vscode-charts-orange)',
    error: 'var(--vscode-charts-red)',
    info: 'var(--vscode-charts-blue)',
    muted: 'var(--vscode-charts-lines)',
    accent: 'var(--vscode-contrastActiveBorder, var(--vscode-focusBorder))',
    'on-accent': 'var(--vscode-editor-background)',
    selected: 'var(--vscode-button-background)',
    'on-selected': 'var(--vscode-button-foreground)',
    primary: 'var(--vscode-button-background)',
    'on-primary': 'var(--vscode-button-foreground)',
    ...Object.fromEntries(
      RAMP_SHARES.map((share, index) => [
        `ramp-${index + 1}`,
        `color-mix(in srgb, var(--vscode-charts-blue) ${Math.round(share * 100)}%, var(--vscode-editor-background))`,
      ]),
    ),
  },
);

/**
 * The scheme as CSS custom properties on the body, for the stylesheets of every page (`--aantje-series-1` to
 * `--aantje-series-12`, `--aantje-ok`, `--aantje-warning`, `--aantje-error`, `--aantje-info`, `--aantje-muted`,
 * `--aantje-accent` and `--aantje-on-accent`, `--aantje-selected` and `--aantje-on-selected` for a pressed control,
 * `--aantje-primary` and `--aantje-on-primary` for the main action of a page,
 * `--aantje-ramp-1` to `--aantje-ramp-5`, and the names `--aantje-navy`, `--aantje-orange`, `--aantje-slate`). VS Code
 * puts the kind of the theme on the body: the light values by default, the dark ones on a dark theme, the theme's own
 * colours in high contrast. The values are those for #ffffff and #1e1e1e; the charts fit theirs to the background.
 */
export const HOUSE_CSS = `body { ${staticVariables(LIGHT_SERIES, LIGHT_ROLES, '#ffffff')} }
body.vscode-dark { ${staticVariables(DARK_SERIES, DARK_ROLES, '#1e1e1e')} }
body.vscode-high-contrast, body.vscode-high-contrast-light { ${CONTRAST_VARIABLES} }`;
