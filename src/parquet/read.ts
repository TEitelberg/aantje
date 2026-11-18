// The footer of one Parquet file, read through DuckDB's Parquet metadata functions on a session of the lake: the
// file is never scanned, only its footer (two small ranged reads on an object store).
import { quoteLiteral } from '../catalog/ddl';
import { isBelowDataPath } from '../catalog/locations';
import { globalValue } from '../catalog/model';
import type { CatalogReader, ColumnInfo, SnapshotId, StoredFile } from '../catalog/model';
import { failureMessageOf, withLakeSession } from '../data/lake-session';
import type { LakeSession } from '../data/lake-session';
import { escapeGlob } from '../data/store-sql';
import type { DataAccess, GridValue } from '../data/types';
import { KEY_VALUES, VALUE_LENGTH, fileName, rowGroupLimit, visibleAt } from './model';
import type {
  BloomProbe,
  ChunkStats,
  FileChoice,
  LakeFile,
  ParquetColumn,
  ParquetData,
  ParquetFileFacts,
  ParquetRowGroup,
  ParquetTarget,
} from './model';

/** The most data files of a table that the pick reads from the catalog. */
export const FILE_LIMIT = 100_000;
// The time limit of a statement when the settings give none.
const STATEMENT_MS = 30_000;

/** The data files of a table at the snapshot that DuckDB can read (Parquet), with the data path of the lake. */
export async function tableFiles(
  reader: Pick<CatalogReader, 'metadata' | 'fileLocations'>,
  tableId: number,
  snapshot: SnapshotId,
  signal?: AbortSignal,
): Promise<{
  readonly files: readonly StoredFile[];
  readonly dataPath: string | null;
  readonly more: boolean;
}> {
  const dataPath = globalValue(await reader.metadata(), 'data_path');
  const places = await reader.fileLocations({ tableId }, dataPath, FILE_LIMIT, signal);
  return {
    files: places.files.filter(
      (file) =>
        file.kind === 'data' &&
        file.format === 'parquet' &&
        file.location !== null &&
        visibleAt(file, snapshot),
    ),
    dataPath: places.dataPath,
    more: places.more,
  };
}

/** The target of a data file of the lake: its facts from the catalog, and whether aantje may open it. */
export function lakeTarget(
  file: StoredFile,
  table: { readonly id: number; readonly name: string },
  snapshot: SnapshotId,
  dataPath: string | null,
): ParquetTarget {
  const location = file.location ?? '';
  const lake: LakeFile = {
    tableId: table.id,
    table: table.name,
    fileId: file.id,
    snapshot,
    beginSnapshot: file.beginSnapshot,
    rows: file.records,
    sizeBytes: file.sizeBytes,
    encrypted: file.encrypted,
    belowDataPath: isBelowDataPath(location, dataPath),
  };
  return { path: location, lake };
}

/**
 * What the inspector reads: a file, and the value to probe the bloom filters of one of its columns with. `files` are the
 * data files of the table that the pick offered, which the panel offers to switch to; the read only passes them on.
 */
export interface InspectParams {
  readonly target: ParquetTarget;
  readonly files?: readonly FileChoice[];
  readonly probe?: { readonly column: number; readonly value: string };
}

/**
 * Reads the footer of the target in a session of the lake, signed in with the storage of the connection like the deep
 * check of the health check. An encrypted lake's file and a path outside the data path are not opened.
 */
export async function inspectFile(
  reader: Pick<CatalogReader, 'columns' | 'columnHistory'>,
  access: DataAccess,
  connection: string,
  { target, files, probe }: InspectParams,
  signal?: AbortSignal,
): Promise<ParquetData> {
  const base = {
    connection,
    target,
    name: fileName(target.path),
    ...(files === undefined ? {} : { files }),
    keyValues: [],
    columns: [],
    rowGroups: [],
  };
  if (target.lake?.encrypted) return { ...base, state: 'encrypted' };
  if (target.lake && !target.lake.belowDataPath) return { ...base, state: 'outside' };
  const lake = target.lake ? await lakeColumns(reader, target.lake.tableId, target.lake.snapshot) : undefined;
  const limitMs = access.timeoutMs ?? STATEMENT_MS;
  try {
    return await withLakeSession(access, signal, async (session): Promise<ParquetData> => {
      const footer = await readFooter(session, target.path, limitMs, lake);
      const column = probe && footer.columns[probe.column];
      if (!probe || !column?.bloomFilter) return { ...base, state: 'read', ...footer };
      try {
        const result = await probeBloom(
          session,
          target.path,
          { index: probe.column, path: column.path },
          probe.value,
          limitMs,
        );
        return { ...base, state: 'read', ...footer, probe: result };
      } catch (error) {
        return { ...base, state: 'read', ...footer, probeError: failureMessageOf(error) };
      }
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...base, state: 'failed', error: failureMessageOf(error) };
  }
}

// The path as a literal; pattern characters become classes, so the path names exactly that file.
const pathArgument = (path: string): string => quoteLiteral(escapeGlob(path));

export const fileStatement = (path: string): string =>
  `SELECT num_rows, num_row_groups, created_by, format_version, encryption_algorithm, file_size_bytes, footer_size FROM parquet_file_metadata(${pathArgument(path)})`;

export const schemaStatement = (path: string): string =>
  `SELECT name, type, num_children, converted_type, logical_type, field_id FROM parquet_schema(${pathArgument(path)})`;

export const columnStatement = (path: string): string =>
  `SELECT column_id, path_in_schema, string_agg(DISTINCT compression, ', ' ORDER BY compression), string_agg(DISTINCT encodings, ', ' ORDER BY encodings), bool_or(dictionary_page_offset IS NOT NULL), bool_or(bloom_filter_offset IS NOT NULL), CAST(sum(total_compressed_size) AS BIGINT), CAST(sum(total_uncompressed_size) AS BIGINT) FROM parquet_metadata(${pathArgument(path)}) GROUP BY column_id, path_in_schema ORDER BY column_id`;

export const rowGroupStatement = (path: string, rowGroups: number): string =>
  `SELECT row_group_id, row_group_num_rows, row_group_compressed_bytes, row_group_bytes, column_id, stats_min_value, stats_max_value, stats_null_count, stats_distinct_count FROM parquet_metadata(${pathArgument(path)}) WHERE row_group_id < ${Math.trunc(rowGroups)} ORDER BY row_group_id, column_id`;

export const keyValueStatement = (path: string): string =>
  `SELECT CAST(key AS VARCHAR), CAST(value AS VARCHAR) FROM parquet_kv_metadata(${pathArgument(path)}) LIMIT ${KEY_VALUES}`;

/** Asks the bloom filters of a column whether a value can be in each row group; the value is a literal. */
export const bloomStatement = (path: string, column: string, value: string): string =>
  `SELECT row_group_id, bloom_filter_excludes FROM parquet_bloom_probe(${pathArgument(path)}, ${quoteLiteral(column)}, ${quoteLiteral(value)}) ORDER BY row_group_id`;

const text = (value: GridValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);
const number = (value: GridValue | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** The DuckLake columns of a table by id, `customer.name` for a nested one; the top-level columns it had too. */
export async function lakeColumns(
  reader: Pick<CatalogReader, 'columns' | 'columnHistory'>,
  tableId: number,
  snapshot: SnapshotId,
): Promise<ReadonlyMap<number, string>> {
  const names = new Map<number, string>();
  const walk = (columns: readonly ColumnInfo[], prefix: string): void => {
    for (const column of columns) {
      const path = prefix === '' ? column.name : `${prefix}.${column.name}`;
      names.set(column.id, path);
      walk(column.children, path);
    }
  };
  walk(await reader.columns(tableId, snapshot), '');
  for (const column of await reader.columnHistory(tableId)) {
    if (!names.has(column.id)) names.set(column.id, `${column.name} (not in the table at this snapshot)`);
  }
  return names;
}

interface SchemaLeaf {
  readonly path: string;
  readonly physicalType: string | null;
  readonly logicalType: string | null;
  readonly fieldId: number | null;
}

/** The leaf columns of `parquet_schema` rows, which list the root, then every field depth first. */
export function schemaLeaves(rows: readonly (readonly GridValue[])[]): SchemaLeaf[] {
  const leaves: SchemaLeaf[] = [];
  // The fields still to come below each open group, with the path of the group.
  const open: { path: string; left: number }[] = [];
  for (const [index, row] of rows.entries()) {
    const [name, type, children, converted, logical, fieldId] = row;
    const parent = open.at(-1);
    const path =
      index === 0
        ? ''
        : parent && parent.path !== ''
          ? `${parent.path}.${text(name) ?? ''}`
          : (text(name) ?? '');
    if (parent) parent.left--;
    const below = number(children) ?? 0;
    if (index > 0 && below === 0) {
      leaves.push({
        path,
        physicalType: text(type),
        logicalType: text(logical) ?? text(converted),
        fieldId: number(fieldId),
      });
    }
    if (below > 0) open.push({ path, left: below });
    while (open.length > 0 && (open.at(-1)?.left ?? 0) === 0) open.pop();
  }
  return leaves;
}

type Footer = Pick<ParquetData, 'file' | 'keyValues' | 'columns' | 'rowGroups'>;

/** Reads the footer of the file: its facts, columns, the first row groups with their statistics, its key/value pairs. */
export async function readFooter(
  session: LakeSession,
  path: string,
  limitMs: number,
  lake: ReadonlyMap<number, string> | undefined,
): Promise<Footer> {
  const [facts] = await session.rows(fileStatement(path), limitMs);
  const leaves = schemaLeaves(await session.rows(schemaStatement(path), limitMs));
  const chunks = await session.rows(columnStatement(path), limitMs);
  const columns = chunks.map(
    (
      [, chunkPath, compression, encodings, dictionary, bloom, compressed, uncompressed],
      index,
    ): ParquetColumn => {
      const leaf = leaves[index];
      const fieldId = leaf?.fieldId ?? null;
      return {
        path: text(chunkPath) ?? leaf?.path ?? '',
        physicalType: leaf?.physicalType ?? null,
        logicalType: leaf?.logicalType ?? null,
        fieldId,
        lakeColumn: fieldId === null ? null : (lake?.get(fieldId) ?? null),
        compression: text(compression) ?? '',
        encodings: text(encodings) ?? '',
        dictionary: dictionary === true,
        bloomFilter: bloom === true,
        compressedBytes: number(compressed) ?? 0,
        uncompressedBytes: number(uncompressed) ?? 0,
      };
    },
  );
  const file: ParquetFileFacts = {
    rows: number(facts?.[0]) ?? 0,
    rowGroups: number(facts?.[1]) ?? 0,
    createdBy: text(facts?.[2]),
    formatVersion: number(facts?.[3]),
    encryption: text(facts?.[4]),
    sizeBytes: number(facts?.[5]),
    footerBytes: number(facts?.[6]),
  };
  const rowGroups = groupRows(
    await session.rows(rowGroupStatement(path, rowGroupLimit(columns.length)), limitMs),
    columns.length,
  );
  const keyValues = (await session.rows(keyValueStatement(path), limitMs)).map(([key, value]) => ({
    key: text(key) ?? '',
    value: (text(value) ?? '').slice(0, VALUE_LENGTH),
  }));
  return { file, columns, rowGroups, keyValues };
}

// One row per row group and column, in that order, into row groups with the statistics of each column.
function groupRows(rows: readonly (readonly GridValue[])[], columns: number): ParquetRowGroup[] {
  const groups = new Map<
    number,
    { id: number; rows: number; compressed: number | null; uncompressed: number; stats: ChunkStats[] }
  >();
  for (const [id, size, compressed, uncompressed, column, min, max, nulls, distinct] of rows) {
    const key = number(id) ?? 0;
    const group = groups.get(key) ?? {
      id: key,
      rows: number(size) ?? 0,
      compressed: number(compressed),
      uncompressed: number(uncompressed) ?? 0,
      stats: Array.from({ length: columns }, (): ChunkStats => ({
        min: null,
        max: null,
        nulls: null,
        distinct: null,
      })),
    };
    groups.set(key, group);
    const at = number(column);
    if (at !== null && at < columns) {
      group.stats[at] = { min: text(min), max: text(max), nulls: number(nulls), distinct: number(distinct) };
    }
  }
  return [...groups.values()].map((group) => ({
    id: group.id,
    rows: group.rows,
    compressedBytes: group.compressed,
    uncompressedBytes: group.uncompressed,
    stats: group.stats,
  }));
}

/** The answer of the bloom filters of a column to a value, for each row group. */
export async function probeBloom(
  session: LakeSession,
  path: string,
  column: { readonly index: number; readonly path: string },
  value: string,
  limitMs: number,
): Promise<BloomProbe> {
  const rows = await session.rows(bloomStatement(path, column.path, value), limitMs);
  return {
    column: column.index,
    value,
    excluded: rows.filter(([, excludes]) => excludes === true).map(([id]) => number(id) ?? 0),
    rowGroups: rows.length,
  };
}
