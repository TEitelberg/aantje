import { describe, expect, it } from 'vitest';
import {
  FALLBACK,
  chartTheme,
  contrastRatio,
  modeOf,
  parseColor,
  readPalette,
} from '../../src/shell/palette';
import type { ColorMode, Palette } from '../../src/shell/palette';

const TEXT_CONTRAST = 4.5;
const GRAPHIC_CONTRAST = 3;

/** The literal names of the CSS variables of VS Code: renaming one in the code must break a test. */
const V = {
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

const styleOf = (variables: Record<string, string>) => ({
  getPropertyValue: (name: string) => variables[name] ?? '',
});

/** What VS Code 1.1xx sets for Dark+, Light+ and the two high contrast themes (see the notes of the spike in the plan). */
const THEME: Record<ColorMode, Record<string, string>> = {
  dark: {
    [V.background]: '#1e1e1e',
    [V.foreground]: '#cccccc',
    [V.lines]: 'rgba(204, 204, 204, 0.5)',
    [V.blue]: '#3794ff',
    [V.green]: '#89d185',
    [V.purple]: '#b180d7',
    [V.yellow]: '#cca700',
    [V.orange]: '#d18616',
    [V.red]: '#f14c4c',
    [V.fontFamily]: 'Segoe UI, sans-serif',
    [V.fontSize]: '13px',
  },
  light: {
    [V.background]: '#ffffff',
    [V.foreground]: '#616161',
    [V.lines]: 'rgba(97, 97, 97, 0.5)',
    [V.blue]: '#1a85ff',
    [V.green]: '#388a34',
    [V.purple]: '#652d90',
    [V.yellow]: '#bf8803',
    [V.orange]: '#b86e00',
    [V.red]: '#e51400',
    [V.fontFamily]: 'Segoe UI, sans-serif',
    [V.fontSize]: '13px',
  },
  hc: {
    [V.background]: '#000000',
    [V.foreground]: '#ffffff',
    [V.lines]: '#ffffff',
    [V.blue]: '#6fc3df',
    [V.green]: '#73c991',
    [V.purple]: '#c586c0',
    [V.yellow]: '#ffd37a',
    [V.orange]: '#ff9d3d',
    [V.red]: '#f48771',
    [V.fontFamily]: 'Segoe UI, sans-serif',
    [V.fontSize]: '14px',
  },
  'hc-light': {
    [V.background]: '#ffffff',
    [V.foreground]: '#292929',
    [V.lines]: '#292929',
    [V.blue]: '#0f4a85',
    [V.green]: '#374e06',
    [V.purple]: '#652d90',
    [V.yellow]: '#895503',
    [V.orange]: '#8a4b00',
    [V.red]: '#b5200d',
    [V.fontFamily]: 'Segoe UI, sans-serif',
    [V.fontSize]: '13px',
  },
};

describe('colours and contrast', () => {
  it('reads the mode of a class list, defaulting to dark', () => {
    const cases: [string, ColorMode][] = [
      ['vscode-dark', 'dark'],
      ['vscode-light', 'light'],
      ['vscode-high-contrast', 'hc'],
      ['vscode-high-contrast-light', 'hc-light'],
      ['vscode-reduce-motion vscode-light', 'light'],
      ['vscode-high-contrast vscode-dark', 'hc'],
      ['', 'dark'],
    ];
    for (const [classNames, mode] of cases) {
      expect(modeOf(classNames), classNames).toBe(mode);
    }
  });

  it('reads hex and rgb colours, lays a translucent one over the background, and refuses the rest', () => {
    expect(parseColor('#3794ff')).toEqual([55, 148, 255]);
    expect(parseColor('#3794FF')).toEqual([55, 148, 255]);
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
    expect(parseColor('rgb(55, 148, 255)')).toEqual([55, 148, 255]);
    expect(parseColor('rgb(55 148 255)')).toEqual([55, 148, 255]);
    expect(parseColor('rgba(204, 204, 204, 0.5)', [30, 30, 30])).toEqual([117, 117, 117]);
    expect(parseColor('rgb(255 0 0 / 50%)', [255, 255, 255])).toEqual([255, 127.5, 127.5]);
    expect(parseColor('#ffffff00', [10, 20, 30])).toEqual([10, 20, 30]);
    for (const text of [
      '',
      'red',
      '#12345',
      'rgb(300, 0, 0)',
      'rgba(1, 2, 3, 2)',
      'var(--x)',
      'hsl(0, 0%, 0%)',
    ]) {
      expect(parseColor(text), text).toBeUndefined();
    }
  });

  it('gives the WCAG contrast ratio: 21 for black on white, 1 for equal colours, 4.5 at #767676 on white', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 10);
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 10);
    expect(contrastRatio([90, 90, 90], [90, 90, 90])).toBe(1);
    expect(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255])).toBeCloseTo(4.54, 2);
    expect(contrastRatio([0x77, 0x77, 0x77], [255, 255, 255])).toBeLessThan(4.5);
  });

  it('has fallback palettes that can be seen on their own background, with no colour twice', () => {
    for (const mode of Object.keys(FALLBACK) as ColorMode[]) {
      const palette = FALLBACK[mode];
      const background = parseColor(palette.background) ?? [0, 0, 0];
      const ratio = (color: string): number => contrastRatio(parseColor(color) ?? [0, 0, 0], background);
      expect(ratio(palette.foreground), mode).toBeGreaterThanOrEqual(TEXT_CONTRAST);
      const colors = [...palette.series, palette.warning, palette.error];
      for (const color of colors) {
        expect(ratio(color), `${color} on ${palette.background}`).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST);
      }
      expect(new Set(colors).size, mode).toBe(colors.length);
    }
  });
});

describe('readPalette', () => {
  it('reads every colour, the font and the size from the variable of its own name', () => {
    // none of these is a fallback colour, so a variable that is not read cannot go unnoticed
    expect(
      readPalette(
        styleOf({
          [V.background]: '#202020',
          [V.foreground]: '#eeeeee',
          [V.lines]: '#999999',
          [V.blue]: '#4488ff',
          [V.green]: '#66cc66',
          [V.purple]: '#bb88ee',
          [V.yellow]: '#ddcc33',
          [V.orange]: '#ee8822',
          [V.red]: '#ff5555',
          [V.fontFamily]: 'Fira Sans',
          [V.fontSize]: '15px',
        }),
        'dark',
      ),
    ).toEqual({
      background: '#202020',
      foreground: '#eeeeee',
      lines: '#999999',
      series: ['#4488ff', '#66cc66', '#bb88ee', '#ddcc33'],
      warning: '#ee8822',
      error: '#ff5555',
      fontFamily: 'Fira Sans',
      fontSize: 15,
    });
  });

  it('keeps the colours of each built-in theme, lays translucent lines over the background, and falls back for nothing', () => {
    for (const mode of Object.keys(THEME) as ColorMode[]) {
      const theme = THEME[mode];
      const palette = readPalette(styleOf(theme), mode);
      expect(palette.series, mode).toEqual([theme[V.blue], theme[V.green], theme[V.purple], theme[V.yellow]]);
      expect(palette.warning, mode).toBe(theme[V.orange]);
      expect(palette.error, mode).toBe(theme[V.red]);
      expect(palette.background, mode).toBe(theme[V.background]);
      expect(readPalette(styleOf({}), mode), mode).toEqual(FALLBACK[mode]);
    }
    expect(readPalette(styleOf(THEME.dark), 'dark').lines).toBe('#757575');
  });

  it('takes the font size of the theme and keeps the fallback for one that is missing or not positive', () => {
    expect(readPalette(styleOf(THEME.hc), 'hc').fontSize).toBe(14);
    for (const size of ['large', '0px', '-5px', '']) {
      expect(readPalette(styleOf({ ...THEME.dark, [V.fontSize]: size }), 'dark').fontSize, size).toBe(13);
    }
  });

  it('replaces a colour that cannot be read, and only that one', () => {
    const palette = readPalette(
      styleOf({ ...THEME.dark, [V.green]: 'green', [V.red]: 'var(--oops)' }),
      'dark',
    );
    expect(palette.series).toEqual(['#3794ff', FALLBACK.dark.series[1], '#b180d7', '#cca700']);
    expect(palette.error).toBe(FALLBACK.dark.error);
    expect(palette.warning).toBe('#d18616');
  });

  it('replaces a colour with too little contrast to the background of the theme by the fallback of its mode', () => {
    const palette = readPalette(
      styleOf({ ...THEME.dark, [V.yellow]: '#212121', [V.foreground]: '#6a6a6a' }),
      'dark',
    );
    expect(palette.series[3]).toBe(FALLBACK.dark.series[3]);
    expect(palette.foreground).toBe(FALLBACK.dark.foreground);
    expect(palette.series[0]).toBe('#3794ff');

    // The yellow and the green of Dark+ on a white background have less than 2.1:1: they are replaced, the blue is not.
    const onWhite = readPalette(styleOf({ ...THEME.dark, [V.background]: '#ffffff' }), 'light');
    expect(onWhite.series[3]).toBe(FALLBACK.light.series[3]);
    expect(onWhite.series[1]).toBe(FALLBACK.light.series[1]);
    expect(onWhite.series[0]).toBe('#3794ff');
  });

  it('asks text for 4.5:1 and the other colours for 3:1, to the very edge, and mixes a translucent colour in first', () => {
    const foreground = (color: string) =>
      readPalette(styleOf({ ...THEME.light, [V.foreground]: color }), 'light').foreground;
    expect(foreground('#767676')).toBe('#767676');
    expect(foreground('#777777')).toBe(FALLBACK.light.foreground);
    const blue = (color: string) =>
      readPalette(styleOf({ ...THEME.light, [V.blue]: color }), 'light').series[0];
    expect(blue('#949494')).toBe('#949494');
    expect(blue('#959595')).toBe(FALLBACK.light.series[0]);
    const marks = readPalette(styleOf({ ...THEME.dark, [V.orange]: '#1e1e1e', [V.red]: '#212121' }), 'dark');
    expect([marks.warning, marks.error]).toEqual([FALLBACK.dark.warning, FALLBACK.dark.error]);
    const translucent = readPalette(styleOf({ ...THEME.dark, [V.blue]: 'rgba(55, 148, 255, 0.9)' }), 'dark');
    expect(translucent.series[0]).toBe('#3588e9');
  });
});

describe('chartTheme', () => {
  const palette = (mode: ColorMode): Palette => readPalette(styleOf(THEME[mode]), mode);

  it('gives the palette series in order, patterns only in the high contrast themes, and a solid text-coloured grid there', () => {
    const decal = (mode: ColorMode) =>
      (chartTheme(palette(mode), mode).aria as { decal: { show: boolean } }).decal.show;
    expect([decal('dark'), decal('light'), decal('hc'), decal('hc-light')]).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(chartTheme(palette('dark'), 'dark').color).toEqual(['#3794ff', '#89d185', '#b180d7', '#cca700']);

    const grid = (mode: ColorMode, lines?: string) => {
      const base = readPalette(styleOf({ ...THEME[mode], ...(lines ? { [V.lines]: lines } : {}) }), mode);
      return (chartTheme(base, mode).valueAxis as { splitLine: { lineStyle: { color: string } } }).splitLine
        .lineStyle.color;
    };
    expect(grid('hc')).toBe('#ffffff');
    expect(grid('hc-light')).toBe('#292929');
    expect(grid('hc', '#808080')).toBe('#ffffff');
    expect(grid('dark')).not.toBe(grid('hc'));
  });
});
