// The read of Suggest Partitioning: the table from the catalog, the filters of the local Query History, read with
// DuckDB's parser, and the measurements of the data on a read-only session of the lake.
import { globalValue } from '../catalog/model';
import type { CatalogReader, ColumnInfo, MetadataEntry, SnapshotId } from '../catalog/model';
import { failureMessageOf, withLakeSession } from '../data/lake-session';
import type { DataAccess } from '../data/types';
import { isObject } from '../guards';
import { percent } from '../shell/model';
import type { HistoryEntry } from '../sql/history';
import { filterUses } from './filters';
import type { FilterUse } from './filters';
import { largestShare, measureColumns } from './measure';
import { DEFAULT_TARGET_FILE_BYTES, candidatesOf, isPartitionable, isTemporal, sortOrderOf } from './model';
import type { Candidate, PartitionData, PartitionTable } from './model';

// The columns measured: the most filtered, the times, and a few more when the history names few.
const FILTERED_COLUMNS = 6;
const TEMPORAL_COLUMNS = 3;
const MEASURED_COLUMNS = 8;
// The candidates whose largest partition is measured: a scan with GROUP BY each.
const SKEW_CANDIDATES = 3;
// The time limit of a statement when the settings give none.
const STATEMENT_MS = 30_000;

export interface PartitionSources {
  readonly reader: Pick<CatalogReader, 'columns' | 'partitioning' | 'sortOrder' | 'metadata' | 'tables'>;
  readonly access: DataAccess;
  /** The statements of this user's Query History of the connection, and the parser that reads them; nothing runs. */
  readonly history: readonly HistoryEntry[];
  readonly serialize: (sql: string) => Promise<string>;
}

/** The `target_file_size` of the table, else of the lake, in bytes; DuckLake's default without one. */
export function targetFileBytes(metadata: readonly MetadataEntry[], tableId: number): number {
  const own = metadata.find(
    (entry) => entry.key === 'target_file_size' && entry.scope === 'table' && entry.scopeId === tableId,
  );
  const value = Number(own?.value ?? globalValue(metadata, 'target_file_size'));
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_TARGET_FILE_BYTES;
}

/** The parse documents of the statements that ran without an error. */
async function documents(sources: PartitionSources, signal?: AbortSignal): Promise<unknown[]> {
  const parsed: unknown[] = [];
  for (const entry of sources.history.filter(({ status }) => status === 'ok')) {
    if (signal?.aborted) break;
    try {
      parsed.push(JSON.parse(await sources.serialize(entry.sql)) as unknown);
    } catch {
      // A statement DuckDB gives no readable answer for is no query.
    }
  }
  return parsed;
}

/** The columns to measure: the most filtered, then the times, then a few more of the table. */
export function measuredColumns(
  columns: readonly ColumnInfo[],
  filters: readonly { readonly column: string; readonly use: FilterUse }[],
): ColumnInfo[] {
  const usable = columns.filter((column) => isPartitionable(column.type));
  const filtered = filters
    .slice(0, FILTERED_COLUMNS)
    .flatMap(({ column }) => usable.filter((candidate) => candidate.name === column));
  const temporal = usable.filter((column) => isTemporal(column.type)).slice(0, TEMPORAL_COLUMNS);
  const chosen = [...new Set([...filtered, ...temporal])];
  const more = chosen.length < 2 ? usable.filter((column) => !chosen.includes(column)) : [];
  return [...chosen, ...more].slice(0, MEASURED_COLUMNS);
}

const SKEW_SHARE = 0.5;

// The largest partition of a candidate: a share of the rows far above its fair share is a risk.
function withSkew(candidate: Candidate, share: number): Candidate {
  const skewed = share >= SKEW_SHARE && share > 3 / candidate.partitions;
  return {
    ...candidate,
    largestShare: share,
    ...(skewed
      ? {
          risks: [...candidate.risks, `Skewed: the largest partition holds ${percent(share)} of the rows.`],
          score: candidate.score - 2,
        }
      : {}),
  };
}

const layoutText = (keys: readonly string[]): string | null => (keys.length === 0 ? null : keys.join(', '));

/** Reads the table, the filters of the history and the measurements, and makes the suggestions. */
export async function readPartitioning(
  sources: PartitionSources,
  connection: string,
  table: Omit<PartitionTable, 'rows' | 'sizeBytes' | 'files'>,
  signal?: AbortSignal,
): Promise<PartitionData | null> {
  const { reader } = sources;
  const snapshot: SnapshotId = table.snapshot;
  const info = (await reader.tables(table.schemaId, snapshot)).find(({ id }) => id === table.id);
  if (!info) return null;
  const [columns, metadata, sortOrder] = await Promise.all([
    reader.columns(table.id, snapshot),
    reader.metadata(),
    reader.sortOrder(table.id, snapshot),
  ]);
  const partitioning = await reader.partitioning(table.id, snapshot, columns);
  const parsed = await documents(sources, signal);
  const { uses, queries: tableQueries } = filterUses(parsed, {
    schema: table.schema,
    name: table.name,
    columns: columns.map(({ name }) => name),
  });
  const filters = [...uses]
    .map(([column, use]) => ({ column, use }))
    .toSorted((a, b) => b.use.queries - a.use.queries || a.column.localeCompare(b.column));
  const base = {
    connection,
    table: { ...table, rows: info.stats.rows, sizeBytes: info.stats.sizeBytes, files: info.stats.files },
    current: {
      partitioning: layoutText(
        partitioning?.columns.map(({ path, transform }) =>
          transform === 'identity' ? path.join('.') : `${transform}(${path.join('.')})`,
        ) ?? [],
      ),
      sortOrder: layoutText(
        sortOrder?.expressions.map(({ expression, direction }) => `${expression} ${direction}`) ?? [],
      ),
    },
    targetFileBytes: targetFileBytes(metadata, table.id),
    history: {
      statements: sources.history.length,
      queries: parsed.filter((document) => isObject(document) && document['error'] !== true).length,
      tableQueries,
    },
    filters,
  };
  const limitMs = sources.access.timeoutMs ?? STATEMENT_MS;
  try {
    return await withLakeSession(sources.access, signal, async (session): Promise<PartitionData> => {
      const { rows, measures } = await measureColumns(
        session,
        table,
        measuredColumns(columns, filters).map(({ name, type }) => ({ name, type })),
        limitMs,
      );
      const found = candidatesOf(measures, uses, {
        rows,
        bytes: info.stats.sizeBytes,
        targetFileBytes: base.targetFileBytes,
        tableQueries,
      });
      const measured: Candidate[] = [];
      for (const [at, candidate] of found.entries()) {
        measured.push(
          at < SKEW_CANDIDATES
            ? withSkew(candidate, await largestShare(session, table, candidate.keys, rows, limitMs))
            : candidate,
        );
      }
      const candidates = measured.toSorted((a, b) => b.score - a.score || a.risks.length - b.risks.length);
      const sort = sortOrderOf(filters, candidates, info.stats.sizeBytes);
      return { ...base, measures, candidates, ...(sort ? { sortOrder: sort } : {}) };
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...base, measures: [], candidates: [], measureError: failureMessageOf(error) };
  }
}
