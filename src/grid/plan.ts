import { isObject, own } from '../guards';
import { plural, secondsText } from '../shell/numbers';
import { clipTo } from './model';
import type { ResultSet } from './results-model';
import { isPlan } from './results-model';

/** One operator of a plan, from `EXPLAIN (FORMAT JSON)` or `EXPLAIN (ANALYZE, FORMAT JSON)`. */
export interface PlanNode {
  /** The operator as DuckDB names it, e.g. `HASH_JOIN`. */
  readonly name: string;
  /** Its details (table, join condition, projections...) as label and text, without the estimate. */
  readonly details: readonly (readonly [string, string])[];
  /** DuckDB's estimate of the rows, as it writes it. */
  readonly estimated: string | undefined;
  /** Measured by EXPLAIN ANALYZE: the rows that left the operator, and its time in seconds. */
  readonly rows: number | undefined;
  readonly seconds: number | undefined;
  readonly children: readonly PlanNode[];
}

export interface Plan {
  /** EXPLAIN ANALYZE: the operators carry measured rows and times. */
  readonly analyzed: boolean;
  readonly root: PlanNode;
  /** The figures of the whole statement that EXPLAIN ANALYZE measured. */
  readonly totalSeconds: number | undefined;
  readonly operators: number;
}

/** More operators than any honest plan has; a larger tree is not drawn. */
const MAX_PLAN_OPERATORS = 5000;

/** The operators that the result, EXPLAIN ANALYZE and a prepared statement (the SQL editor prepares each one) put above a plan. */
export const PLAN_WRAPPERS: ReadonlySet<string> = new Set(['RESULT_COLLECTOR', 'EXPLAIN_ANALYZE', 'EXECUTE']);
const ESTIMATE = 'Estimated Cardinality';

/** A finite number of the JSON, else undefined. */
export const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const text = (value: unknown): string =>
  Array.isArray(value)
    ? value.map((item) => text(item)).join(', ')
    : isObject(value)
      ? JSON.stringify(value)
      : String(value);

/** The plan of an EXPLAIN in JSON, or undefined for a plan in text, a broken one or one too large. */
export function planOf(set: ResultSet): Plan | undefined {
  if (!isPlan(set) || set.rows.length !== 1) return undefined;
  const [key, value] = set.rows[0] ?? [];
  return typeof value === 'string' ? parsePlan(String(key), value) : undefined;
}

/** The profile of Statistics as a plan: DuckDB's JSON profiler writes the same tree as EXPLAIN ANALYZE. */
export function profilePlan(json: string): Plan | undefined {
  return parsePlan('analyzed_plan', json);
}

function parsePlan(key: string, value: string): Plan | undefined {
  if (!/^\s*[[{]/.test(value)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return undefined;
  }
  let operators = 0;
  const analyzed = key === 'analyzed_plan';

  const node = (raw: unknown): PlanNode | undefined => {
    if (!isObject(raw) || ++operators > MAX_PLAN_OPERATORS) return undefined;
    const name = own(raw, analyzed ? 'type' : 'name');
    const extra = own(raw, 'extra_info');
    const entries = isObject(extra) ? Object.entries(extra) : [];
    const rawChildren = own(raw, 'children');
    const children: PlanNode[] = [];
    for (const child of Array.isArray(rawChildren) ? (rawChildren as unknown[]) : []) {
      const built = node(child);
      if (!built) return undefined;
      children.push(built);
    }
    return {
      name: typeof name === 'string' && name !== '' ? name : '?',
      details: entries
        .filter(([label]) => label !== ESTIMATE)
        .map(([label, detail]) => [label, text(detail)] as const),
      estimated: entries.find(([label]) => label === ESTIMATE)?.[1]?.toString(),
      rows: analyzed ? finiteNumber(own(raw, 'intermediate_rows')) : undefined,
      seconds: analyzed ? finiteNumber(own(raw, 'timing')) : undefined,
      children,
    };
  };

  const roots = analyzed ? (isObject(json) ? own(json, 'operator') : undefined) : json;
  const built = (Array.isArray(roots) ? (roots as unknown[]) : []).map(node);
  if (built.length === 0 || built.some((root) => root === undefined)) return undefined;
  let root: PlanNode =
    built.length === 1
      ? (built[0] as PlanNode)
      : {
          name: 'PLAN',
          details: [],
          estimated: undefined,
          rows: undefined,
          seconds: undefined,
          children: built as PlanNode[],
        };
  // The statement's plan starts below the wrappers of EXPLAIN ANALYZE.
  while (PLAN_WRAPPERS.has(root.name) && root.children.length === 1) root = root.children[0] as PlanNode;
  const query = analyzed && isObject(json) ? own(json, 'query') : undefined;
  return {
    analyzed,
    root,
    totalSeconds: isObject(query) ? finiteNumber(own(query, 'total_time')) : undefined,
    operators: count(root),
  };
}

function count(node: PlanNode): number {
  return 1 + node.children.reduce((sum, child) => sum + count(child), 0);
}

/** The total time, when it was measured, and the number of operators: the start of the line above a plan or profile. */
const totalAndOperators = (plan: Plan): string[] => [
  ...(plan.totalSeconds === undefined ? [] : [`Total time ${secondsText(plan.totalSeconds)}`]),
  plural(plan.operators, 'operator'),
];

/** The line above the drawing. */
export function planSummary(plan: Plan): string {
  return [
    ...totalAndOperators(plan),
    plan.analyzed
      ? 'rows and time as measured; the time of an operator adds up all its threads and can exceed the total; red and orange mark the slowest; hover an operator for its details'
      : 'rows as DuckDB estimates them (~); nothing ran; hover an operator for its details',
  ].join(' · ');
}

/** The line above the table of a profile (Statistics). */
export function profileSummary(plan: Plan): string {
  return [
    ...totalAndOperators(plan),
    'the time of an operator adds up all its threads and can exceed the total',
  ].join(' · ');
}

/** A share of the time of all operators: `12.5 %`, `0.42 %`; empty without one. */
export const shareText = (share: number | undefined): string =>
  share === undefined ? '' : `${(share * 100).toFixed(share < 0.01 ? 2 : 1)} %`;

/** DuckDB's estimate of the rows as a number, when it wrote one that reads as a number. */
export function estimateOf(node: PlanNode): number | undefined {
  const value = Number((node.estimated ?? '').replace(/[^0-9.]/g, ''));
  return node.estimated !== undefined && Number.isFinite(value) ? value : undefined;
}

const capitalized = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** The operator as people read it: `HASH_JOIN` with join type INNER is `Hash Join (Inner)`. */
export function operatorTitle(node: PlanNode): string {
  const title = typeTitle(node);
  const join = node.details.find(([label]) => label === 'Join Type')?.[1];
  return join
    ? `${title} (${join
        .split(/[_\s]+/)
        .map(capitalized)
        .join(' ')})`
    : title;
}

/** The time of all operators together, in seconds: each one's own time, so the shares add up to 100 %. */
export function totalOperatorSeconds(node: PlanNode): number {
  return (node.seconds ?? 0) + node.children.reduce((sum, child) => sum + totalOperatorSeconds(child), 0);
}

/** Where an operator goes, as in the plans of SQL Server Management Studio: a column per level from the result on the left, the first input in the row of its operator, each further input below the inputs before it. */
export interface PlanPlace {
  readonly node: PlanNode;
  readonly depth: number;
  readonly row: number;
  /** The index of the operator that reads it; undefined for the result. */
  readonly parent: number | undefined;
}

export function placesOf(root: PlanNode): PlanPlace[] {
  const places: PlanPlace[] = [];
  const place = (node: PlanNode, depth: number, row: number, parent: number | undefined): number => {
    const index = places.push({ node, depth, row, parent }) - 1;
    let next = row;
    for (const child of node.children) next += place(child, depth + 1, next, index);
    return Math.max(1, next - row);
  };
  place(root, 0, 0, undefined);
  return places;
}

/** The time of the slowest operator, in seconds; 0 for a plan without times. */
export function slowestSeconds(node: PlanNode): number {
  return Math.max(node.seconds ?? 0, ...node.children.map(slowestSeconds));
}

// The detail that tells most about an operator, in this order; the others are in the tooltip.
const MAIN_DETAILS = [
  'Table',
  'Function',
  'Join Type',
  'Conditions',
  'Groups',
  'Aggregates',
  'Order By',
  'Filters',
];

/** The one detail that goes into the operator's box, shortened. */
export function mainDetail(node: PlanNode, max = 42): string {
  const found =
    MAIN_DETAILS.map((label) => node.details.find(([key]) => key === label)).find(Boolean) ?? node.details[0];
  if (!found) return '';
  return clipTo(`${found[0]}: ${found[1]}`.replace(/\s+/g, ' '), max);
}

/** The kinds of operators: the statistics and the charts colour them, the plan gives each kind its symbol. */
export type OperatorKind =
  | 'scan'
  | 'join'
  | 'aggregate'
  | 'cte'
  | 'union'
  | 'filter'
  | 'sort'
  | 'window'
  | 'limit'
  | 'projection'
  | 'other';

// The one classification of DuckDB's operator names; the first pattern that matches wins.
const KINDS: readonly (readonly [RegExp, OperatorKind])[] = [
  [/CTE/, 'cte'],
  [/SCAN|READ/, 'scan'],
  [/JOIN|PRODUCT/, 'join'],
  [/GROUP|AGGREGATE|DISTINCT/, 'aggregate'],
  [/UNION|UNNEST/, 'union'],
  [/FILTER/, 'filter'],
  [/ORDER|SORT|TOP_N/, 'sort'],
  [/WINDOW/, 'window'],
  [/LIMIT/, 'limit'],
  [/PROJECTION/, 'projection'],
];

export function kindOf(node: PlanNode): OperatorKind {
  return KINDS.find(([pattern]) => pattern.test(node.name))?.[1] ?? 'other';
}

/** The type of an operator, for grouping: `HASH_GROUP_BY` is `Hash Group By`, whatever its join type. */
export function typeTitle(node: PlanNode): string {
  return node.name.split('_').filter(Boolean).map(capitalized).join(' ');
}

const detailOf = (node: PlanNode, label: string): string | undefined =>
  node.details.find(([key]) => key === label)?.[1];

/** The table or the function that an operator reads, as DuckDB names it. */
export const objectNameOf = (node: PlanNode): string | undefined =>
  detailOf(node, 'Table') ?? detailOf(node, 'Function');

/** A short name that says what the operator works on: `Scan fact_sales`, `Join date_key = date_key`, `Group By #0, #1`. */
function shortName(node: PlanNode): string {
  const table = objectNameOf(node);
  switch (kindOf(node)) {
    case 'scan':
      return table ? `Scan ${table.split('.').at(-1) ?? table}` : operatorTitle(node);
    case 'join': {
      const conditions = detailOf(node, 'Conditions');
      return conditions ? `Join ${clipTo(conditions, 40)}` : operatorTitle(node);
    }
    case 'aggregate': {
      const groups = detailOf(node, 'Groups');
      return groups ? `Group By ${clipTo(groups, 40)}` : operatorTitle(node);
    }
    default:
      return operatorTitle(node);
  }
}

/** The time of an operator and of all operators below it, in seconds. */
function subtreeSeconds(): (node: PlanNode) => number {
  const known = new Map<PlanNode, number>();
  const of = (node: PlanNode): number => {
    const found = known.get(node);
    if (found !== undefined) return found;
    const seconds = (node.seconds ?? 0) + node.children.reduce((sum, child) => sum + of(child), 0);
    known.set(node, seconds);
    return seconds;
  };
  return of;
}

/** One row of the Statistics table. */
export interface OperatorRow {
  readonly node: PlanNode;
  readonly depth: number;
  /** `Result` above the first operator with several inputs; below it, each input named by its main table. */
  readonly branch: string;
  readonly kind: OperatorKind;
  readonly name: string;
  /** Its own time and its share of the time of all operators. */
  readonly seconds: number | undefined;
  readonly share: number | undefined;
  readonly details: string;
}

/** The main table of a subtree: the table of its first scan, or the function it reads, e.g. `range`. */
function mainTable(node: PlanNode): string | undefined {
  const table =
    kindOf(node) === 'scan'
      ? (detailOf(node, 'Table') ?? detailOf(node, 'Function')?.toLowerCase())
      : undefined;
  if (table) return table.split('.').at(-1) ?? table;
  for (const child of node.children) {
    const found = mainTable(child);
    if (found) return found;
  }
  return undefined;
}

export function operatorRows(plan: Plan): OperatorRow[] {
  const total = totalOperatorSeconds(plan.root);
  const rows: OperatorRow[] = [];
  const visit = (node: PlanNode, depth: number, branch: string): void => {
    rows.push({
      node,
      depth,
      branch,
      kind: kindOf(node),
      name: shortName(node),
      seconds: node.seconds,
      share: node.seconds === undefined || total <= 0 ? undefined : node.seconds / total,
      details: clipTo(node.details.map(([label, detail]) => `${label}: ${detail}`).join(' · '), 200),
    });
    const names = node.children.map((child, index) => mainTable(child) ?? `Input ${index + 1}`);
    node.children.forEach((child, index) => {
      const name = names[index] ?? '';
      // Two inputs that read the same table or function keep their number.
      const unique = names.indexOf(name) === names.lastIndexOf(name) ? name : `${name} (${index + 1})`;
      visit(child, depth + 1, names.length > 1 ? unique : branch);
    });
  };
  visit(plan.root, 0, 'Result');
  return rows;
}

/** A bar of the flame graph: an operator from where it starts to where it ends on the axis of the cumulated time. */
export interface FlameBar {
  readonly node: PlanNode;
  readonly depth: number;
  readonly kind: OperatorKind;
  readonly name: string;
  /** In seconds: the bar starts where the bars of its siblings before it end, and is as long as its subtree's time. */
  readonly start: number;
  readonly seconds: number;
}

export function flameBars(plan: Plan): FlameBar[] {
  const subtree = subtreeSeconds();
  const bars: FlameBar[] = [];
  const visit = (node: PlanNode, depth: number, start: number): void => {
    bars.push({ node, depth, kind: kindOf(node), name: shortName(node), start, seconds: subtree(node) });
    let next = start;
    for (const child of node.children) {
      visit(child, depth + 1, next);
      next += subtree(child);
    }
  };
  visit(plan.root, 0, 0);
  return bars;
}
