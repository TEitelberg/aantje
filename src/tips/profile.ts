// What the tips need from DuckDB's JSON profile (DuckDB 2.0): the scans of lake tables, the time of all operators, the
// bytes read and the bytes spilled. The profile is read defensively: a field that is missing or of another shape leaves
// its fact unknown.
import { finiteNumber, MAX_PLAN_OPERATORS, PLAN_WRAPPERS } from '../grid/plan';
import { isObject, own } from '../guards';

/** One scan of a table, as the profile names it (`lake.<schema>.<table>`). */
export interface ScanFacts {
  /** The `Table` of the scan as DuckDB writes it, e.g. `lake.main."Sales"`. */
  readonly table: string;
  /** Its catalog, schema and table, unquoted; undefined when the text is no qualified name. */
  readonly parts: readonly string[] | undefined;
  /** The columns the scan reads. */
  readonly projections: readonly string[];
  /** The text of its filters and dynamic filters. */
  readonly filters: string;
  /** `Total Files Read`. */
  readonly filesRead: number | undefined;
  /** Whether the files it read are on a remote storage; undefined when the profile names no file. */
  readonly remote: boolean | undefined;
  /** The rows that left the scan. */
  readonly rows: number;
  /** Its own time, all threads together. */
  readonly seconds: number;
}

export interface ProfileFacts {
  readonly scans: readonly ScanFacts[];
  /** The time of all operators together (each one's own time), as the shares of Statistics count it. */
  readonly operatorSeconds: number;
  /** `io.total_bytes_read`: what the statement read from files, local or remote, not from DuckDB's cache. */
  readonly bytesRead: number | undefined;
  /** `system.peak_temp_dir_size`: what the statement wrote to the temporary directory because memory ran out. */
  readonly tempBytes: number | undefined;
  /** `system.peak_buffer_memory`. */
  readonly peakMemory: number | undefined;
  /** The plan stops reading early (LIMIT without ORDER BY), so a scan reads only the start of its table. */
  readonly stopsEarly: boolean;
}

// The operators of a LIMIT that stops the scans once it has its rows; TOP_N (ORDER BY ... LIMIT) reads everything.
const EARLY_STOPS: ReadonlySet<string> = new Set(['STREAMING_LIMIT', 'LIMIT']);

// A file that is not on this machine: what DuckDB reads through httpfs or the Azure extension.
const REMOTE_FILE = /(?:^|[\s,])(?:s3a?|r2|gcs|gs|az|azure|abfss?|https?|hf):\/\//i;

const texts = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.filter((item) => typeof item === 'string')
      : [];

// DuckDB writes a value with line breaks as a list of its lines.
const textOf = (value: unknown): string => texts(value).join('\n');

/**
 * The parts of a qualified name as DuckDB writes it: separated by dots, a part in double quotes (inner quotes doubled)
 * when it needs them, e.g. `lake.main."Sales ""2026"""`. Undefined for text that is no such name.
 */
export function nameParts(text: string): string[] | undefined {
  const parts: string[] = [];
  let at = 0;
  for (;;) {
    if (text[at] === '"') {
      let part = '';
      at += 1;
      for (;;) {
        const end = text.indexOf('"', at);
        if (end < 0) return undefined;
        part += text.slice(at, end);
        at = end + 1;
        if (text[at] !== '"') break;
        part += '"';
        at += 1;
      }
      parts.push(part);
    } else {
      const dot = text.indexOf('.', at);
      const end = dot < 0 ? text.length : dot;
      parts.push(text.slice(at, end));
      at = end;
    }
    if (at === text.length) return parts;
    if (text[at] !== '.') return undefined;
    at += 1;
  }
}

const numberOf = (value: unknown): number | undefined =>
  typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : finiteNumber(value);

function scanOf(node: Record<string, unknown>): ScanFacts | undefined {
  const info = own(node, 'extra_info');
  if (own(node, 'type') !== 'TABLE_SCAN' || !isObject(info)) return undefined;
  const table = textOf(own(info, 'Table'));
  if (table === '') return undefined;
  const files = textOf(own(info, 'Filename(s)'));
  return {
    table,
    parts: nameParts(table),
    projections: texts(own(info, 'Projections')),
    filters: [...texts(own(info, 'Filters')), ...texts(own(info, 'Dynamic Filters'))].join('\n'),
    filesRead: numberOf(own(info, 'Total Files Read')),
    remote: files === '' ? undefined : REMOTE_FILE.test(files),
    rows: finiteNumber(own(node, 'intermediate_rows')) ?? 0,
    seconds: finiteNumber(own(node, 'timing')) ?? 0,
  };
}

/** The facts of a profile, or undefined when it is no JSON profile of DuckDB or larger than a plan may be. */
export function profileFacts(json: string): ProfileFacts | undefined {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return undefined;
  }
  const operators = isObject(root) ? own(root, 'operator') : undefined;
  if (!isObject(root) || !Array.isArray(operators)) return undefined;
  const scans: ScanFacts[] = [];
  let seconds = 0;
  let visited = 0;
  let stopsEarly = false;
  const stack: unknown[] = [...(operators as readonly unknown[])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isObject(node)) continue;
    if (++visited > MAX_PLAN_OPERATORS) return undefined;
    const type = own(node, 'type');
    if (typeof type === 'string' && !PLAN_WRAPPERS.has(type)) {
      seconds += finiteNumber(own(node, 'timing')) ?? 0;
      stopsEarly ||= EARLY_STOPS.has(type);
    }
    const scan = scanOf(node);
    if (scan) scans.push(scan);
    const children = own(node, 'children');
    if (Array.isArray(children)) stack.push(...(children as readonly unknown[]));
  }
  const io = own(root, 'io');
  const system = own(root, 'system');
  return {
    scans,
    operatorSeconds: seconds,
    bytesRead: isObject(io) ? finiteNumber(own(io, 'total_bytes_read')) : undefined,
    tempBytes: isObject(system) ? finiteNumber(own(system, 'peak_temp_dir_size')) : undefined,
    peakMemory: isObject(system) ? finiteNumber(own(system, 'peak_buffer_memory')) : undefined,
    stopsEarly,
  };
}

/** The share of all operator time that a scan took; 0 when the profile measured no time. */
export const shareOf = (facts: ProfileFacts, seconds: number): number =>
  facts.operatorSeconds > 0 ? seconds / facts.operatorSeconds : 0;
