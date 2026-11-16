// Gathers what the tips need beyond the profile: for each table that a slow scan read, its size, sort order, the bytes
// of its columns, how the ranges of its filter column overlap, and the maintenance the Advisor would recommend. Reads
// the catalog through the explorer's reader, never through the session of the editor (its transaction is the user's).
import { rewriteFloor } from '../advisor/model';
import { policyOf } from '../advisor/read';
import { sameIdentifier } from '../catalog/ddl';
import { isBelowDataPath } from '../catalog/locations';
import { globalValue } from '../catalog/model';
import type { CatalogEntry, CatalogReader, ColumnInfo, SnapshotId, ValueRange } from '../catalog/model';
import { comparatorOf } from '../catalog/statistics';
import { LARGE_INLINED_ROWS, SMALL_FILE_BYTES, hasManySmallFiles } from '../catalog/thresholds';
import { LAKE } from '../data/attach';
import { mentions } from '../ddl-script/names';
import { count, formatBytes } from '../shell/model';
import type { Tip } from './model';
import { profileFacts, shareOf } from './profile';
import type { ProfileFacts, ScanFacts } from './profile';
import { MAINTENANCE_SHARE, MAX_RANGES, overlapOf, tipsOf } from './rules';
import type { MaintenanceFinding, Overlap, TableFacts } from './rules';

export type TipsReader = Pick<
  CatalogReader,
  | 'info'
  | 'metadata'
  | 'entries'
  | 'tables'
  | 'columns'
  | 'sortOrder'
  | 'columnBytes'
  | 'columnFileRanges'
  | 'fileLocations'
  | 'maintenanceFacts'
  | 'deleteHeavyTables'
>;

/** The row groups of a data file, as the ranges of one column; undefined when the footer cannot be read. */
export type RowGroupRanges = (
  location: string,
  column: string,
  signal: AbortSignal,
) => Promise<readonly ValueRange[] | undefined>;

export interface TipsDeps {
  /** The catalog; without it (the explorer is not connected) only the tips from the profile alone are given. */
  readonly reader?: TipsReader;
  /** Reads Parquet footers; without it a table of one file gets no sort-order tip. */
  readonly rowGroups?: RowGroupRanges;
}

/** What the profiler hands over: DuckDB's JSON profile, and the memory limit of the session when it ran. */
export interface ProfileReport {
  readonly json: string;
  readonly memoryLimit?: string;
}

/** The most tables whose catalog facts are read, the slowest scans first. */
const MAX_TABLES = 5;
/** The most filter columns of a scan whose ranges are compared. */
const MAX_FILTER_COLUMNS = 3;
/** The files of a table that are looked at to find its one current data file. */
const LOCATION_LIMIT = 16;

/** The tips of a profiled run. Throws when the catalog cannot be read; the caller then shows none. */
export async function collectTips(
  deps: TipsDeps,
  report: ProfileReport,
  signal: AbortSignal,
): Promise<Tip[]> {
  const facts = profileFacts(report.json);
  if (!facts) return [];
  const tables = deps.reader ? await tableFacts(deps.reader, deps.rowGroups, facts, signal) : [];
  return tipsOf(facts, tables, report.memoryLimit);
}

// The slowest scan of each table among those with a share worth a tip.
function slowestScans(facts: ProfileFacts): ScanFacts[] {
  const slowest = new Map<string, ScanFacts>();
  for (const scan of facts.scans) {
    if (shareOf(facts, scan.seconds) < MAINTENANCE_SHARE) continue;
    const known = slowest.get(scan.table);
    if (!known || scan.seconds > known.seconds) slowest.set(scan.table, scan);
  }
  return [...slowest.values()].toSorted((a, b) => b.seconds - a.seconds).slice(0, MAX_TABLES);
}

async function tableFacts(
  reader: TipsReader,
  rowGroups: RowGroupRanges | undefined,
  facts: ProfileFacts,
  signal: AbortSignal,
): Promise<TableFacts[]> {
  const scans = slowestScans(facts);
  if (scans.length === 0) return [];
  const { latestSnapshot: snapshot } = await reader.info();
  const [entries, metadata] = await Promise.all([reader.entries(snapshot), reader.metadata()]);
  const context: Context = {
    reader,
    rowGroups,
    snapshot,
    signal,
    dataPath: globalValue(metadata, 'data_path'),
    policy: policyOf(metadata),
  };
  const found = await Promise.all(
    scans.map(async (scan) => {
      // The profile names the table `lake.<schema>.<table>`, each part quoted when it needs it.
      const [catalog, schema, table, ...more] = scan.parts ?? [];
      const matches =
        catalog === LAKE && more.length === 0
          ? entries.filter(
              (entry) => entry.kind === 'table' && entry.schemaName === schema && entry.name === table,
            )
          : [];
      return matches.length === 1 && matches[0] ? oneTable(context, scan, matches[0]) : undefined;
    }),
  );
  return found.filter((table): table is TableFacts => table !== undefined);
}

interface Context {
  readonly reader: TipsReader;
  readonly rowGroups: RowGroupRanges | undefined;
  readonly snapshot: SnapshotId;
  readonly signal: AbortSignal;
  readonly dataPath: string | null;
  readonly policy: ReturnType<typeof policyOf>;
}

// `"name"` or `name`: the column a sort expression is, if it is one.
function sortColumn(expression: string): string {
  const bare = expression.trim();
  return /^"((?:[^"]|"")*)"$/.exec(bare)?.[1]?.replaceAll('""', '"') ?? bare;
}

async function oneTable(
  context: Context,
  scan: ScanFacts,
  entry: CatalogEntry,
): Promise<TableFacts | undefined> {
  const { reader, snapshot, signal, policy } = context;
  const [tables, columns, sortOrder, bytes, maintenance, heavy] = await Promise.all([
    reader.tables(entry.schemaId, snapshot),
    reader.columns(entry.id, snapshot),
    reader.sortOrder(entry.id, snapshot),
    reader.columnBytes(entry.id, snapshot, signal),
    reader.maintenanceFacts({ tableId: entry.id }, 2, signal),
    reader.deleteHeavyTables({ tableId: entry.id }, rewriteFloor(policy), policy.rewrite.share, 2, signal),
  ]);
  const stats = tables.find((table) => table.id === entry.id)?.stats;
  if (!stats) return undefined;
  const firstKey = sortOrder?.expressions[0];
  const sortedBy = firstKey ? sortColumn(firstKey.expression) : undefined;
  const filtered = columns
    .filter(
      (column) =>
        !(sortedBy !== undefined && sameIdentifier(sortedBy, column.name)) &&
        mentions(scan.filters, column.name),
    )
    .slice(0, MAX_FILTER_COLUMNS);
  const overlap = await mostOverlap(context, entry, stats.files, filtered);
  const named = new Map(columns.map((column) => [column.name, column]));
  const projectedBytes = bytes
    ? scan.projections
        .flatMap((name) => {
          const column = named.get(name);
          return column ? [[name, bytes.get(column.id) ?? 0] as const] : [];
        })
        .toSorted((a, b) => b[1] - a[1])
    : undefined;
  return {
    scan,
    schema: entry.schemaName,
    name: entry.name,
    rows: stats.rows,
    bytes: stats.sizeBytes,
    sorted: firstKey !== undefined,
    ...(projectedBytes ? { projectedBytes } : {}),
    ...(overlap ? { overlap } : {}),
    maintenance: findings(entry.id, maintenance, heavy),
  };
}

// The filter column whose ranges overlap most: over the files of the table from the catalog, or over the row groups
// of its one file from the Parquet footer.
async function mostOverlap(
  context: Context,
  entry: CatalogEntry,
  files: number,
  columns: readonly ColumnInfo[],
): Promise<Overlap | undefined> {
  const { reader, snapshot, signal } = context;
  let location: Promise<string | undefined> | undefined;
  let best: Overlap | undefined;
  for (const column of columns) {
    const compare = comparatorOf(column.type);
    if (!compare) continue;
    let ranges: readonly ValueRange[] | undefined;
    let unit: Overlap['unit'] = 'file';
    if (files >= 2) {
      ranges = await reader.columnFileRanges(entry.id, column.id, snapshot, MAX_RANGES, signal);
    } else if (files === 1 && context.rowGroups) {
      location ??= oneFile(context, entry.id);
      const file = await location;
      unit = 'row group';
      ranges = file === undefined ? undefined : await context.rowGroups(file, column.name, signal);
    }
    const measured = ranges ? overlapOf(ranges, compare) : undefined;
    if (measured && (!best || measured.share > best.share)) {
      best = { column: column.name, unit, ...measured };
    }
  }
  return best;
}

// The location of the table's one current data file, if it lies below the data path: a footer is read only there.
async function oneFile(context: Context, tableId: number): Promise<string | undefined> {
  // Only the current files: a table that was compacted often has many ended files with lower ids before its own.
  const { files } = await context.reader.fileLocations(
    { tableId },
    context.dataPath,
    LOCATION_LIMIT,
    context.signal,
    true,
  );
  const current = files.filter((file) => file.kind === 'data');
  const location = current.length === 1 ? current[0]?.location : undefined;
  return location && isBelowDataPath(location, context.dataPath) ? location : undefined;
}

// What the Maintenance Advisor would recommend for the table, in its order: rewrite, merge, flush.
function findings(
  tableId: number,
  maintenance: Awaited<ReturnType<TipsReader['maintenanceFacts']>>,
  heavy: Awaited<ReturnType<TipsReader['deleteHeavyTables']>>,
): MaintenanceFinding[] {
  const deleted = heavy.find((table) => table.tableId === tableId);
  const small = maintenance.smallFiles.find(
    (table) =>
      table.tableId === tableId && hasManySmallFiles({ files: table.files, smallFiles: table.small }),
  );
  const inlined = maintenance.inlined.find(
    (table) => table.tableId === tableId && table.rows > LARGE_INLINED_ROWS,
  );
  return [
    ...(deleted
      ? [
          {
            kind: 'rewrite' as const,
            fact: `${count(deleted.deleted)} of its ${count(deleted.records)} rows are deleted but still in its files, and every read filters them out again.`,
          },
        ]
      : []),
    ...(small
      ? [
          {
            kind: 'merge' as const,
            fact: `${count(small.small)} of its ${count(small.files)} files are smaller than ${formatBytes(SMALL_FILE_BYTES)}, and every file is one more read.`,
            // As in the Advisor: the merge rewrites small files with deleted rows first; null when unreadable.
            ...(small.deleted === null || small.deleted.small > 0 ? { deleted: small.deleted } : {}),
          },
        ]
      : []),
    ...(inlined
      ? [
          {
            kind: 'flush' as const,
            fact: `${count(inlined.rows)} of its rows are kept in the catalog (inlined) instead of in Parquet files.`,
          },
        ]
      : []),
  ];
}
