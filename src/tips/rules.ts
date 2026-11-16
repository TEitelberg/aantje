// The rules of the performance tips: pure functions from the facts of a profile and of the scanned tables to tips.
// The thresholds keep the tab quiet: a tip names something that took a real share of the time.
import type { Compare } from '../catalog/statistics';
import type { ValueRange } from '../catalog/model';
import type { DeletedFiles } from '../catalog/model';
import { count, formatBytes, groupedPlural, percent } from '../shell/model';
import { shownName, shownTable } from './model';
import type { Tip } from './model';
import { shareOf } from './profile';
import type { ProfileFacts, ScanFacts } from './profile';
import { maintenanceScript, sortScript } from './scripts';
import type { TableMaintenanceKind } from './scripts';

/** The share of all operator time from which a scan is worth a tip about its layout, its columns or the storage. */
export const SCAN_SHARE = 0.2;
/** The share from which the maintenance of a scanned table is worth a tip. */
export const MAINTENANCE_SHARE = 0.1;
/** A scan that returns at most this share of the rows of its table filtered enough for a sort order to pay off. */
const SELECTIVE = 0.5;
/** Files or row groups overlap when each one shares its range with at least this share of the others, on average. */
const OVERLAPPING = 0.5;
/** A scan that reads fewer columns, or fewer bytes of them, is no tip about columns. */
const MANY_COLUMNS = 4;
const MANY_COLUMN_BYTES = 16 * 1024 * 1024;
/** The columns that the tip about columns lists by name. */
const LISTED_COLUMNS = 5;
/** From this size of a table on, the sort-order tip names partitioning as an alternative. */
const LARGE_TABLE_BYTES = 10 * 1024 ** 3;
/** The most files or row groups whose ranges are compared, pair by pair. */
export const MAX_RANGES = 1000;

/** How much the ranges of a column overlap across the files or row groups of a table. */
export interface Overlap {
  readonly column: string;
  readonly unit: 'file' | 'row group';
  /** The files or row groups whose ranges were compared. */
  readonly units: number;
  /** The share of the other units that a unit overlaps, on average: about 1 unsorted, about 0 sorted. */
  readonly share: number;
}

/** A maintenance step that the Maintenance Advisor would recommend for a table, with the fact behind it. */
export interface MaintenanceFinding {
  readonly kind: TableMaintenanceKind;
  readonly fact: string;
  readonly deleted?: DeletedFiles | null;
}

/** What the catalog says about a table that a scan read. */
export interface TableFacts {
  readonly scan: ScanFacts;
  readonly schema: string;
  readonly name: string;
  readonly rows: number;
  readonly bytes: number;
  /** Whether the table has a sort order (by another expression than the overlapping column). */
  readonly sorted: boolean;
  /** The columns the scan reads with their bytes in the table, the largest first; undefined when unknown. */
  readonly projectedBytes?: readonly (readonly [string, number])[];
  /** The overlap of the column the scan filters on, when it was measured. */
  readonly overlap?: Overlap;
  readonly maintenance: readonly MaintenanceFinding[];
}

/**
 * The share of the other ranges that a range overlaps, on average, over the ranges that are recorded and of the type;
 * undefined for fewer than two. Ranges that only touch do not overlap: sorted data meets at the boundaries.
 */
export function overlapOf(
  ranges: readonly ValueRange[],
  compare: Compare,
): { readonly units: number; readonly share: number } | undefined {
  const units = ranges
    .flatMap(({ min, max }) => {
      if (min === null || max === null) return [];
      try {
        compare(min, min);
        compare(max, max);
        return [[min, max] as const];
      } catch {
        return [];
      }
    })
    .slice(0, MAX_RANGES);
  if (units.length < 2) return undefined;
  let total = 0;
  for (const [index, [low, high]] of units.entries()) {
    let overlapping = 0;
    for (const [other, [otherLow, otherHigh]] of units.entries()) {
      if (other !== index && compare(otherLow, high) < 0 && compare(low, otherHigh) < 0) overlapping += 1;
    }
    total += overlapping / (units.length - 1);
  }
  return { units: units.length, share: total / units.length };
}

const scanText = (facts: ProfileFacts, scan: ScanFacts): string =>
  `It took ${percent(shareOf(facts, scan.seconds))} of the time`;

function cacheTip(facts: ProfileFacts): Tip | undefined {
  const remote = facts.scans.filter((scan) => scan.remote === true);
  const share = shareOf(
    facts,
    remote.reduce((sum, scan) => sum + scan.seconds, 0),
  );
  if (remote.length === 0 || share < SCAN_SHARE || facts.bytesRead === undefined) return undefined;
  const scans = `${groupedPlural(remote.length, 'scan')} of files on a remote storage took ${percent(share)} of the time.`;
  return facts.bytesRead > 0
    ? {
        kind: 'cache',
        title: `This run read ${formatBytes(facts.bytesRead)} from files, the remote ones from the storage.`,
        facts: [
          scans,
          'DuckDB keeps what it reads from remote files in memory for the rest of the session, so a second run reads less from the storage, or nothing.',
        ],
        advice:
          'Run the statement a second time and compare before you change anything: the difference is the time the storage took.',
      }
    : {
        kind: 'cache',
        title: "This run read nothing from the storage: the data came from DuckDB's cache.",
        facts: [
          scans,
          'The cache lasts as long as the session of this editor; a new session reads from the storage again.',
        ],
        advice: 'Expect the first run in a new session to be slower, and compare runs of the same kind.',
      };
}

function spillTip(facts: ProfileFacts, memoryLimit: string | undefined): Tip | undefined {
  if (!facts.tempBytes) return undefined;
  const limit = memoryLimit ? ` of the limit of ${shownName(memoryLimit)}` : '';
  return {
    kind: 'spill',
    title: `The statement wrote ${formatBytes(facts.tempBytes)} to the temporary directory: its data did not fit into memory.`,
    facts: [
      ...(facts.peakMemory ? [`Its memory reached ${formatBytes(facts.peakMemory)}${limit}.`] : []),
      'Writing to the temporary directory and reading it back is much slower than memory.',
    ],
    advice:
      "Raise the limit for this editor with SET memory_limit = '…' if the machine has the memory free, or give the sorts, joins and aggregates less data: filter earlier and read only the columns the statement needs.",
  };
}

function sortTip(facts: ProfileFacts, table: TableFacts): Tip | undefined {
  const { scan, overlap } = table;
  if (
    !overlap ||
    shareOf(facts, scan.seconds) < SCAN_SHARE ||
    table.rows === 0 ||
    scan.rows > table.rows * SELECTIVE ||
    overlap.share < OVERLAPPING
  ) {
    return undefined;
  }
  const name = shownTable(table.schema, table.name);
  const column = shownName(overlap.column);
  const units =
    overlap.unit === 'file'
      ? `The ranges of ${column} in its ${count(overlap.units)} files overlap: a file shares its range with ${percent(overlap.share)} of the others on average.`
      : `Its one file has ${count(overlap.units)} row groups whose ranges of ${column} overlap: a row group shares its range with ${percent(overlap.share)} of the others on average.`;
  return {
    kind: 'sort',
    title: `The scan of ${name} could skip no ${overlap.unit} through its filter on ${column}.`,
    facts: [
      `${scanText(facts, scan)} and returned ${count(scan.rows)} of the ${count(table.rows)} rows of the table.`,
      units,
      table.sorted ? 'The table is sorted by another expression.' : 'The table has no sort order.',
    ],
    advice: `Sort the table by ${column}: DuckLake then skips the files and row groups whose range of ${column} the filter excludes. The script sets the sort order and writes the existing rows again in that order.${
      table.bytes >= LARGE_TABLE_BYTES
        ? ' For a table this large, partitioning by a coarse form of the column (for example its year) is an alternative.'
        : ''
    }`,
    script: sortScript(table.schema, table.name, overlap.column, {
      rows: table.rows,
      bytes: table.bytes,
      replaces: table.sorted,
    }),
  };
}

function columnsTip(facts: ProfileFacts, table: TableFacts): Tip | undefined {
  const columns = table.projectedBytes;
  if (!columns || facts.stopsEarly || shareOf(facts, table.scan.seconds) < SCAN_SHARE) return undefined;
  const bytes = columns.reduce((sum, [, size]) => sum + size, 0);
  if (columns.length < MANY_COLUMNS || bytes < MANY_COLUMN_BYTES) return undefined;
  const listed = columns
    .slice(0, LISTED_COLUMNS)
    .map(([column, size]) => `${shownName(column)} ${formatBytes(size)}`)
    .join(', ');
  const rest = columns.length - LISTED_COLUMNS;
  return {
    kind: 'columns',
    title: `The scan of ${shownTable(table.schema, table.name)} reads ${count(columns.length)} columns, ${formatBytes(bytes)} in the table.`,
    facts: [
      `${scanText(facts, table.scan)}.`,
      `The largest: ${listed}${rest > 0 ? `, and ${groupedPlural(rest, 'more column')}` : ''}.`,
    ],
    advice:
      'If the statement needs only some of them, name those instead of SELECT *: DuckDB reads only the columns that a statement uses.',
  };
}

function maintenanceTip(facts: ProfileFacts, table: TableFacts): Tip | undefined {
  if (table.maintenance.length === 0 || shareOf(facts, table.scan.seconds) < MAINTENANCE_SHARE)
    return undefined;
  return {
    kind: 'maintenance',
    title: `${shownTable(table.schema, table.name)} needs maintenance that makes reading it faster.`,
    facts: [
      ...table.maintenance.map(({ fact }) => fact),
      `Its scan took ${percent(shareOf(facts, table.scan.seconds))} of the time.`,
    ],
    advice:
      'Run the maintenance in a read/write session. The Maintenance Advisor shows what the whole lake needs.',
    script: maintenanceScript(table.schema, table.name, table.maintenance),
  };
}

/** The tips of a profile: the storage and memory first, then each scanned table, the slowest first. */
export function tipsOf(facts: ProfileFacts, tables: readonly TableFacts[], memoryLimit?: string): Tip[] {
  const byShare = tables.toSorted((a, b) => b.scan.seconds - a.scan.seconds);
  return [
    cacheTip(facts),
    spillTip(facts, memoryLimit),
    ...byShare.flatMap((table) => [
      sortTip(facts, table),
      columnsTip(facts, table),
      maintenanceTip(facts, table),
    ]),
  ].filter((tip): tip is Tip => tip !== undefined);
}
