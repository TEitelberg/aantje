import { describe, expect, it } from 'vitest';
import { graphOption } from '../../src/dependencies/graph-option';
import { mermaidGraph } from '../../src/dependencies/markdown';
import type { DependenciesData } from '../../src/dependencies/model';
import { picture } from '../../src/dependencies/picture';
import type { Picture } from '../../src/dependencies/picture';
import type { Palette } from '../../src/shell/palette';

/**
 * The graph of the Dependencies report: boxes in columns along the data flow, what the graph of an object holds, the
 * series that ECharts draws, and the same graph as a Mermaid flowchart.
 */

const HOSTILE = '<img src=x onerror=alert(1)> & "q" #`';

// events ← big_events ← top → gross; items ← other; top names the missing old_stuff.
const lake: DependenciesData = {
  connection: 'C',
  scope: { kind: 'lake' },
  snapshot: 1,
  target: null,
  isolated: 0,
  objects: 4,
  parsed: 4,
  nodes: [
    { kind: 'view', id: 1, schemaId: 1, schema: 'shop', name: 'big_events' },
    { kind: 'table', id: 2, schemaId: 1, schema: 'shop', name: 'events' },
    { kind: 'scalarMacro', id: 3, schemaId: 1, schema: 'shop', name: 'gross' },
    { kind: 'table', id: 4, schemaId: 1, schema: 'shop', name: 'items' },
    { kind: 'view', id: 5, schemaId: 1, schema: 'shop', name: HOSTILE },
    { kind: 'view', id: 6, schemaId: 1, schema: 'shop', name: 'top' },
  ],
  edges: [
    { from: 0, to: 1, kind: 'reads' },
    { from: 5, to: 0, kind: 'reads' },
    { from: 5, to: 2, kind: 'calls' },
    { from: 4, to: 3, kind: 'reads' },
  ],
  broken: [{ from: 5, kind: 'relation', schema: 'shop', name: 'old_stuff' }],
  unresolved: [],
};
const ofBigEvents: DependenciesData = { ...lake, target: 0 };

const columns = (shown: Picture): Record<string, number> =>
  Object.fromEntries(shown.items.map(({ name, column }) => [name, column]));
const names = (shown: Picture): string[] => shown.items.map(({ name }) => name);
const arrows = (shown: Picture): string[] =>
  shown.edges.map(({ from, to }) => `${shown.items[from]?.name} → ${shown.items[to]?.name}`);

describe('the boxes of the graph', () => {
  it('stand in columns along the data flow, with the names that no object has before the objects that name them', () => {
    const shown = picture(lake, { directions: ['usedBy'], depth: 5, reach: 'connected' });
    expect(columns(shown)).toEqual({
      'shop.events': 0,
      'shop.gross': 0,
      'shop.items': 0,
      'shop.old_stuff': 0,
      'shop.big_events': 1,
      [`shop.${HOSTILE}`]: 1,
      'shop.top': 2,
    });
    expect(arrows(shown)).toContain('shop.events → shop.big_events');
    expect(arrows(shown)).toContain('shop.old_stuff → shop.top');
    expect(shown.items.find(({ name }) => name === 'shop.old_stuff')?.kind).toBe('missing');
    // Each column is centred: four boxes take the rows -1.5 to 1.5.
    expect(shown.items.filter(({ column }) => column === 0).map(({ row }) => row)).toEqual([
      -1.5, -0.5, 0.5, 1.5,
    ]);
  });

  it('hold for an object what is connected to it in the direction and depth, and everything else faint on Show all', () => {
    const used = picture(ofBigEvents, { directions: ['usedBy'], depth: 5, reach: 'connected' });
    expect(names(used)).toEqual(['shop.big_events', 'shop.top', 'shop.old_stuff']);
    const uses = picture(ofBigEvents, { directions: ['dependsOn'], depth: 1, reach: 'connected' });
    expect(names(uses)).toEqual(['shop.big_events', 'shop.events']);

    const all = picture(ofBigEvents, { directions: ['usedBy'], depth: 5, reach: 'all' });
    expect(all.items).toHaveLength(7);
    expect(all.items.filter(({ faint }) => faint).map(({ name }) => name)).toEqual([
      'shop.events',
      'shop.gross',
      'shop.items',
      `shop.${HOSTILE}`,
    ]);
  });

  it('end at a cycle', () => {
    const cycle: DependenciesData = {
      ...lake,
      edges: [
        { from: 0, to: 5, kind: 'reads' },
        { from: 5, to: 0, kind: 'reads' },
      ],
      broken: [],
    };
    const shown = picture(cycle, { directions: ['usedBy'], depth: 5, reach: 'all' });
    expect(new Set(shown.items.map(({ column }) => column))).toEqual(new Set([0, 1]));
  });
});

describe('the series that ECharts draws', () => {
  const palette: Palette = {
    background: '#000000',
    foreground: '#ffffff',
    lines: '#888888',
    series: ['#0000ff', '#00ff00', '#ff00ff', '#ffff00'],
    warning: '#ff8800',
    error: '#ff0000',
    fontFamily: 'sans-serif',
    fontSize: 13,
  };
  type Series = {
    data: { x: number; symbolSize: number; itemStyle: { opacity: number } }[];
    links: { lineStyle: { color: string; type: string } }[];
    center?: number[];
    zoom?: number;
  };
  const seriesOf = (centre?: number): Series => {
    const shown = picture(ofBigEvents, { directions: ['usedBy'], depth: 5, reach: 'all' });
    const option = graphOption(
      { picture: shown, target: 0, selected: undefined, centre, contrast: false },
      palette,
    ) as { series: Series[] };
    return option.series[0] as Series;
  };

  it('puts a column further right along the data flow, draws the object of the report larger, and zooms in on request', () => {
    const series = seriesOf();
    const shown = picture(ofBigEvents, { directions: ['usedBy'], depth: 5, reach: 'all' });
    const x = (name: string): number | undefined =>
      series.data[shown.items.findIndex((item) => item.name === name)]?.x;
    expect(x('shop.events')).toBeLessThan(x('shop.big_events') ?? 0);
    expect(x('shop.big_events')).toBeLessThan(x('shop.top') ?? 0);
    const sizes = series.data.map(({ symbolSize }) => symbolSize);
    expect(sizes.filter((size) => size === Math.max(...sizes))).toHaveLength(1);
    expect(series.links.filter(({ lineStyle }) => lineStyle.color === palette.error)).toHaveLength(1);
    expect(series.links.filter(({ lineStyle }) => lineStyle.type === 'dashed')).toHaveLength(2);
    expect(series.center).toBeUndefined();

    const zoomed = seriesOf(5);
    expect(zoomed.center).toEqual([x('shop.top'), expect.any(Number)]);
    expect(zoomed.zoom).toBeGreaterThan(1);
  });
});

describe('the graph as a Mermaid flowchart', () => {
  it('draws each box and arrow once, with catalog text as entity codes, and counts a graph too large to draw', () => {
    const lines = mermaidGraph(picture(lake, { directions: ['usedBy'], depth: 5, reach: 'all' }));
    expect(lines[0]).toBe('```mermaid');
    expect(lines.at(-1)).toBe('```');
    const boxes = lines.filter((line) => /^ {2}n\d+\W/.test(line) && !line.includes('-'));
    expect(boxes).toHaveLength(7);
    expect(lines.filter((line) => /^ {2}n\d+ -\.?-+> n\d+$/.test(line))).toHaveLength(5);
    const hostile = boxes.find((line) => line.includes('img'));
    // Only the two quotes around the label are left; nothing of the name can close it or start HTML.
    expect(hostile?.match(/["<>&`]/g)).toEqual(['"', '"']);

    const many: DependenciesData = {
      ...lake,
      nodes: Array.from({ length: 200 }, (_, id) => ({
        kind: 'view' as const,
        id,
        schemaId: 1,
        schema: 's',
        name: `v${id}`,
      })),
      edges: Array.from({ length: 199 }, (_, index) => ({ from: index + 1, to: 0, kind: 'reads' as const })),
      broken: [],
    };
    const large = mermaidGraph(picture(many, { directions: ['usedBy'], depth: 5, reach: 'all' }));
    expect(large).toHaveLength(1);
    expect(large[0]).toContain('200');
  });
});
