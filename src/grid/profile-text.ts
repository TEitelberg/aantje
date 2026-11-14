// Text Statistics: DuckDB's JSON profile as text, made in the results page from the same JSON as the table and the
// charts. It lists every operator, also of a profile too large or too odd to draw, and a profile that is no JSON shows
// as DuckDB wrote it.
import { isObject, own } from '../guards';
import { count, formatBytes, secondsText } from '../shell/numbers';
import { finiteNumber, PLAN_WRAPPERS } from './plan';

// The figures of the whole statement, as DuckDB 2.0 names them in the JSON profile.
const FIGURES: readonly (readonly [string, string, string, (value: number) => string])[] = [
  ['Total time', 'query', 'total_time', secondsText],
  ['CPU time', 'query', 'cpu_time', secondsText],
  ['Rows scanned', 'query', 'total_rows_scanned', count],
  ['Row groups scanned', 'query', 'total_row_groups_scanned', count],
  ['Bytes read', 'io', 'total_bytes_read', formatBytes],
  ['Bytes written', 'io', 'total_bytes_written', formatBytes],
  ['Peak memory', 'system', 'peak_buffer_memory', formatBytes],
  ['Temporary files, peak', 'system', 'peak_temp_dir_size', formatBytes],
];

const MAX_DETAILS = 160;

function details(extra: unknown): string {
  if (!isObject(extra)) return '';
  const text = Object.entries(extra)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.map(String).join(', ') : String(value)}`)
    .join('; ')
    .replace(/\s+/g, ' ');
  return text.length > MAX_DETAILS ? `${text.slice(0, MAX_DETAILS - 1)}…` : text;
}

interface OperatorLine {
  readonly name: string;
  readonly time: string;
  readonly rows: string;
  readonly details: string;
}

function operatorLines(node: unknown, depth: number, lines: OperatorLine[]): void {
  if (!isObject(node)) return;
  const type = own(node, 'type');
  const timing = finiteNumber(own(node, 'timing'));
  const rows = finiteNumber(own(node, 'intermediate_rows'));
  lines.push({
    name: `${depth === 0 ? '' : `${'   '.repeat(depth - 1)}└─ `}${typeof type === 'string' ? type : '?'}`,
    time: timing === undefined ? '' : secondsText(timing),
    rows: rows === undefined ? '' : count(rows),
    details: details(own(node, 'extra_info')),
  });
  const children = own(node, 'children');
  for (const child of Array.isArray(children) ? (children as unknown[]) : [])
    operatorLines(child, depth + 1, lines);
}

/** The statement's own plan below the operators that the result and a prepared statement put above it. */
function unwrapped(node: unknown): unknown {
  let current = node;
  for (;;) {
    if (!isObject(current) || !PLAN_WRAPPERS.has(String(own(current, 'type')))) return current;
    const children = own(current, 'children');
    if (!Array.isArray(children) || children.length !== 1) return current;
    current = (children as unknown[])[0];
  }
}

/** The profile of DuckDB's JSON profiler as text: the figures of the statement, then the operator tree. */
export function profileText(json: string): string {
  let profile: unknown;
  try {
    profile = JSON.parse(json);
  } catch {
    return json;
  }
  const figures = FIGURES.flatMap(([label, part, key, format]) => {
    const section = isObject(profile) ? own(profile, part) : undefined;
    const value = isObject(section) ? finiteNumber(own(section, key)) : undefined;
    return value === undefined ? [] : [[label, format(value)] as const];
  });
  const width = Math.max(0, ...figures.map(([label]) => label.length));
  const lines = ['Statistics of DuckDB’s profiler for this statement', ''];
  lines.push(...figures.map(([label, value]) => `${label.padEnd(width)}  ${value}`));

  const operators: OperatorLine[] = [];
  const roots = isObject(profile) ? own(profile, 'operator') : undefined;
  for (const root of Array.isArray(roots) ? (roots as unknown[]) : [])
    operatorLines(unwrapped(root), 0, operators);
  if (operators.length > 0) {
    const nameWidth = Math.max('Operator'.length, ...operators.map((line) => line.name.length));
    const timeWidth = Math.max('Time'.length, ...operators.map((line) => line.time.length));
    const rowsWidth = Math.max('Rows'.length, ...operators.map((line) => line.rows.length));
    const row = (name: string, time: string, rows: string, extra: string): string =>
      `${name.padEnd(nameWidth)}  ${time.padStart(timeWidth)}  ${rows.padStart(rowsWidth)}  ${extra}`.trimEnd();
    lines.push(
      '',
      'The time of an operator adds up all threads that ran it, so it can exceed the total time.',
    );
    lines.push(row('Operator', 'Time', 'Rows', 'Details'));
    lines.push(...operators.map((line) => row(line.name, line.time, line.rows, line.details)));
  }
  return lines.join('\n');
}
