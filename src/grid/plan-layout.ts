// The layout of a plan as SQL Server Management Studio draws it: the result on the left, each operator as a tile with
// its figures, a column per level. Pure: the page passes a function that measures text in its font.
import { count, secondsText } from '../shell/numbers';
import { clipTo } from './model';
import {
  estimateOf,
  kindOf,
  mainDetail,
  objectNameOf,
  operatorTitle,
  placesOf,
  shareText,
  slowestSeconds,
  totalOperatorSeconds,
} from './plan';
import type { OperatorKind, Plan, PlanNode, PlanPlace } from './plan';

// The sizes at zoom 1.
export const TITLE_SIZE = 12;
export const TEXT_SIZE = 11;
export const LINE_HEIGHT = 17;
export const PAD_X = 10;
export const PAD_Y = 7;
export const ICON = 16;
export const ICON_GAP = 8;
export const GAP_X = 64;
const GAP_Y = 26;
const MARGIN = 20;
const OBJECT_CHARS = 34;

/** The width of a line in the given font size, at zoom 1. */
export type Measure = (text: string, size: number, bold: boolean) => number;

// One symbol per kind of operator, drawn in a 16 x 16 box with lines only.
const SET = 'M2 2h7v7H2z M7 7h7v7H7z';
const LINES = 'M2 3h12 M2 8h8 M2 13h4';
const ICONS: Readonly<Record<OperatorKind, string>> = {
  scan: 'M1 2h14v12H1z M1 6h14 M1 10h14 M6 2v12',
  join: 'M1 8a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0 M6 8a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0',
  aggregate: 'M13 2H3l6 6-6 6h10',
  sort: 'M4 1v14 M1 12l3 3 3-3 M12 15V1 M9 4l3-3 3 3',
  filter: 'M1 2h14l-5.5 6.5V14l-3-1.5V8.5z',
  limit: LINES,
  window: 'M1 2h14v12H1z M5.5 2v12 M10.5 2v12',
  cte: SET,
  union: SET,
  projection: 'M2 1v14 M6 1v14 M10 1v14 M14 1v14',
  other: 'M2 2h12v12H2z M5 8h6',
};

/** Analysis marks the slowest operators: hot above half the time of the slowest, warm above a quarter. */
export type Accent = 'calm' | 'warm' | 'hot';

/** An operator's tile at zoom 1: where it is, how large, what it says. */
export interface Tile {
  readonly place: PlanPlace;
  readonly title: string;
  readonly object: string;
  readonly figures: readonly string[];
  readonly accent: Accent;
  readonly icon: string;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  /** The rows that flow out of it, which set the width of its arrow. */
  readonly flow: number;
}

export interface Layout {
  readonly tiles: readonly Tile[];
  /** Where the arrows of each level turn: in the middle of the gap right of its column. */
  readonly turns: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly maxFlow: number;
}

/** The figures of a tile, one per line, as in the plans of SQL Server Management Studio. */
function figureLines(node: PlanNode, plan: Plan, total: number): string[] {
  const estimated = estimateOf(node);
  if (!plan.analyzed) {
    return node.estimated === undefined
      ? []
      : [`Estimated rows: ${estimated === undefined ? node.estimated : count(estimated)}`];
  }
  const rows =
    node.rows === undefined
      ? ''
      : estimated === undefined
        ? `${count(node.rows)} rows`
        : `${count(node.rows)} of ${count(estimated)}${estimated > 0 ? ` (${Math.round((node.rows / estimated) * 100)}%)` : ''}`;
  return [
    node.seconds !== undefined && total > 0 ? `Cost: ${shareText(node.seconds / total)}` : '',
    // DuckDB adds up the time of every thread that ran the operator, so it can exceed the time of the query.
    node.seconds === undefined ? '' : `${secondsText(node.seconds)} (all threads)`,
    rows,
  ].filter(Boolean);
}

/** The object of an operator: its table or function, else its main detail. */
function objectOf(node: PlanNode): string {
  return clipTo(objectNameOf(node) ?? mainDetail(node, OBJECT_CHARS), OBJECT_CHARS);
}

/** The tiles in their columns and rows. */
export function layoutOf(plan: Plan, measure: Measure): Layout {
  const slowest = slowestSeconds(plan.root);
  const total = totalOperatorSeconds(plan.root);
  const sized = placesOf(plan.root).map((place): Omit<Tile, 'x' | 'y'> => {
    const { node } = place;
    const share = plan.analyzed && slowest > 0 ? (node.seconds ?? 0) / slowest : 0;
    const title = operatorTitle(node);
    const object = objectOf(node);
    const figures = figureLines(node, plan, total);
    const longest = Math.max(
      measure(title, TITLE_SIZE, true),
      measure(object, TEXT_SIZE, false),
      ...figures.map((line) => measure(line, TEXT_SIZE, false)),
    );
    return {
      place,
      title,
      object,
      figures,
      accent: share >= 0.5 ? 'hot' : share >= 0.25 ? 'warm' : 'calm',
      icon: ICONS[kindOf(node)],
      width: Math.ceil(longest) + ICON + ICON_GAP + 2 * PAD_X + 2,
      height: (1 + (object ? 1 : 0) + figures.length) * LINE_HEIGHT + 2 * PAD_Y,
      flow: (plan.analyzed ? node.rows : estimateOf(node)) ?? 0,
    };
  });
  const depth = Math.max(...sized.map(({ place }) => place.depth)) + 1;
  const columns = Array.from({ length: depth }, (_, level) =>
    Math.max(...sized.filter(({ place }) => place.depth === level).map(({ width }) => width)),
  );
  const lefts = columns.map(
    (_, level) => MARGIN + columns.slice(0, level).reduce((sum, width) => sum + width + GAP_X, 0),
  );
  const rowHeight = Math.max(...sized.map(({ height }) => height)) + GAP_Y;
  const rows = Math.max(...sized.map(({ place }) => place.row)) + 1;
  return {
    tiles: sized.map((tile) => ({
      ...tile,
      x: lefts[tile.place.depth] ?? MARGIN,
      y: MARGIN + tile.place.row * rowHeight,
    })),
    turns: lefts.map((left, level) => left + (columns[level] ?? 0) + GAP_X / 2),
    width: (lefts.at(-1) ?? MARGIN) + (columns.at(-1) ?? 0) + MARGIN,
    height: rows * rowHeight - GAP_Y + 2 * MARGIN,
    maxFlow: Math.max(1, ...sized.map(({ flow }) => flow)),
  };
}
