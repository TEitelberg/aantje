import { AantjeError, isAantjeError } from '../../errors';
import { compareText } from '../../order';
import type { Row, Value } from '../drivers/driver';
import { globalValue } from '../model';
import type {
  CatalogEntry,
  CatalogInfo,
  CatalogProperties,
  CatalogReader,
  FileTotals,
  MetadataEntry,
  SchemaInfo,
  SnapshotInfo,
  StorageInfo,
  TableInfo,
  ViewInfo,
} from '../model';
import * as queries from '../queries/objects';
import { splitExpirable } from '../expirable';
import { splitScheduled } from '../scheduled';
import { toIsoUtc } from '../timestamp';
import { readColumns } from './columns';
import { toIsoUtcOrNull, toNumber, toNumberOrNull, toText, toTextOrNull } from './rows';
import type { Attempt, Run } from './rows';

const SUPPORTED_VERSION = /^1\.\d+$/;

export async function readInfo(run: Run, signal?: AbortSignal): Promise<CatalogInfo> {
  let rows: Row[];
  try {
    rows = await run(queries.info(), signal);
  } catch (cause) {
    // Only a failed statement means the tables do not exist; a lock or timeout says nothing about the database.
    throw isAantjeError(cause) && cause.code === 'QUERY_FAILED'
      ? new AantjeError(
          'NOT_A_DUCKLAKE',
          'This database is not a DuckLake catalog: the tables "ducklake_metadata" and "ducklake_snapshot" are missing or cannot be read.',
          { cause },
        )
      : cause;
  }
  const row = rows[0];
  const version = row?.version;
  if (typeof version !== 'string') {
    throw new AantjeError(
      'NOT_A_DUCKLAKE',
      'This database is not a DuckLake catalog: "ducklake_metadata" has no version entry.',
    );
  }
  if (!SUPPORTED_VERSION.test(version)) {
    throw new AantjeError(
      'UNSUPPORTED_VERSION',
      `The DuckLake specification version "${version}" is not supported. aantje reads catalogs of version 1.x.`,
    );
  }
  return { specVersion: version, latestSnapshot: toNumber(row?.latest_snapshot) };
}

async function readMetadata(run: Run): Promise<MetadataEntry[]> {
  const entries = (await run(queries.metadata())).map((row) => ({
    key: toText(row.key),
    value: toText(row.value),
    scope: toTextOrNull(row.scope ?? null),
    scopeId: toNumberOrNull(row.scope_id ?? null),
  }));
  // The rows have no order, and engines sort NULL first or last.
  return entries.toSorted(
    (a, b) =>
      Number(a.scope !== null) - Number(b.scope !== null) ||
      compareText(a.key, b.key) ||
      compareText(a.scope ?? '', b.scope ?? '') ||
      (a.scopeId ?? -1) - (b.scopeId ?? -1),
  );
}

// The files of one operation share their time, so the rows are few. Older specifications have no such table.
async function readScheduled(
  attempt: Attempt,
  metadata: readonly MetadataEntry[] | PromiseLike<readonly MetadataEntry[]>,
): Promise<StorageInfo['scheduledForDeletion']> {
  const [rows, options] = await Promise.all([attempt(queries.scheduledForDeletion()), metadata]);
  const none = rows ?? [];
  const groups = none.map((row) => ({
    scheduledAt: toIsoUtcOrNull(row.schedule_start),
    files: toNumber(row.file_count),
  }));
  const times = groups.flatMap(({ scheduledAt }) => (scheduledAt === null ? [] : [Date.parse(scheduledAt)]));
  return {
    count: groups.reduce((sum, { files }) => sum + files, 0),
    oldestScheduledAt: times.length === 0 ? null : new Date(Math.min(...times)).toISOString(),
    split: splitScheduled(groups, globalValue(options, 'delete_older_than') ?? undefined, new Date()) ?? null,
  };
}

async function readExpirable(
  run: Run,
  metadata: readonly MetadataEntry[] | PromiseLike<readonly MetadataEntry[]>,
): Promise<StorageInfo['expirableSnapshots']> {
  const [rows, options] = await Promise.all([run(queries.expirableSnapshotTimes()), metadata]);
  const option = globalValue(options, 'expire_older_than')?.trim();
  // An empty option expires nothing, like none.
  return (
    splitExpirable(
      rows.map((row) => toIsoUtcOrNull(row.snapshot_time)),
      option === '' ? undefined : option,
      new Date(),
    ) ?? null
  );
}

// `column_aliases` lists quoted identifiers such as `"a","b,c","d""e"`; empty or NULL without aliases.
function parseColumnAliases(value: Value | undefined): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  return Array.from(value.matchAll(/"((?:[^"]|"")*)"/g), (match) => (match[1] ?? '').replaceAll('""', '"'));
}

type CoreReads = Pick<
  CatalogReader,
  | 'info'
  | 'snapshots'
  | 'schemas'
  | 'tables'
  | 'views'
  | 'columns'
  | 'entries'
  | 'metadata'
  | 'snapshotCount'
  | 'properties'
  | 'scheduledForDeletion'
  | 'expirableSnapshots'
  | 'storage'
>;

/** Reads of the catalog structure: snapshots, schemas, tables, views, columns, properties and storage. */
export function coreReads(run: Run, attempt: Attempt): CoreReads {
  return {
    info: () => readInfo(run),

    metadata: () => readMetadata(run),

    snapshotCount: async () => toNumber((await run(queries.snapshotSummary()))[0]?.snapshot_count),

    scheduledForDeletion: (metadata = readMetadata(run)) => readScheduled(attempt, metadata),

    expirableSnapshots: (metadata = readMetadata(run)) => readExpirable(run, metadata),

    async snapshots(limit?: number): Promise<SnapshotInfo[]> {
      // Older specifications have no commit columns.
      const rows = (await attempt(queries.snapshots(limit))) ?? (await run(queries.snapshots(limit, false)));
      return rows.map((row) => ({
        id: toNumber(row.snapshot_id),
        time: toIsoUtc(toText(row.snapshot_time)),
        changes: toTextOrNull(row.changes_made),
        author: toTextOrNull(row.author ?? null),
        commitMessage: toTextOrNull(row.commit_message ?? null),
        commitExtraInfo: toTextOrNull(row.commit_extra_info ?? null),
      }));
    },

    async schemas(snapshot): Promise<SchemaInfo[]> {
      const rows = await run(queries.schemas(snapshot));
      return rows.map((row) => ({
        id: toNumber(row.schema_id),
        name: toText(row.schema_name),
        comment: toTextOrNull(row.comment_text),
      }));
    },

    async tables(schemaId, snapshot): Promise<TableInfo[]> {
      const rows = await run(queries.tables(schemaId, snapshot));
      return rows.map((row) => ({
        id: toNumber(row.table_id),
        schemaId: toNumber(row.schema_id),
        name: toText(row.table_name),
        comment: toTextOrNull(row.comment_text),
        stats: {
          rows: toNumber(row.row_count),
          files: toNumber(row.file_count),
          sizeBytes: toNumber(row.size_bytes),
          ...(toNumber(row.partial_files) > 0 ? { approximate: true as const } : {}),
        },
      }));
    },

    async views(schemaId, snapshot): Promise<ViewInfo[]> {
      const rows = await run(queries.views(schemaId, snapshot));
      return rows.map((row) => ({
        id: toNumber(row.view_id),
        schemaId: toNumber(row.schema_id),
        name: toText(row.view_name),
        comment: toTextOrNull(row.comment_text),
        sql: toText(row.sql),
        dialect: toText(row.dialect),
        columnAliases: parseColumnAliases(row.column_aliases),
      }));
    },

    columns: (tableId, snapshot) => readColumns(run, tableId, snapshot),

    async entries(snapshot): Promise<CatalogEntry[]> {
      const rows = await run(queries.entries(snapshot));
      return rows.map((row) => ({
        kind: row.kind === 'view' ? 'view' : 'table',
        id: toNumber(row.entry_id),
        name: toText(row.entry_name),
        schemaId: toNumber(row.schema_id),
        schemaName: toText(row.schema_name),
      }));
    },

    async properties(): Promise<CatalogProperties> {
      const [info, metadata, [summary]] = await Promise.all([
        readInfo(run),
        readMetadata(run),
        run(queries.snapshotSummary()),
      ]);
      return {
        specVersion: info.specVersion,
        createdBy: globalValue(metadata, 'created_by'),
        dataPath: globalValue(metadata, 'data_path'),
        encrypted: globalValue(metadata, 'encrypted') === 'true',
        metadata,
        snapshotCount: toNumber(summary?.snapshot_count),
        firstSnapshotTime: toIsoUtcOrNull(summary?.first_time),
        latestSnapshotTime: toIsoUtcOrNull(summary?.latest_time),
      };
    },

    async storage(snapshot, scope = {}): Promise<StorageInfo> {
      const metadataRead = readMetadata(run);
      const [metadata, totals, scheduledForDeletion, expirableSnapshots] = await Promise.all([
        metadataRead,
        run(queries.fileTotals(snapshot, scope)),
        readScheduled(attempt, metadataRead),
        readExpirable(run, metadataRead),
      ]);
      const totalsOf = (kind: string): FileTotals => {
        const row = totals.find((candidate) => candidate.kind === kind);
        return { count: toNumber(row?.file_count), sizeBytes: toNumber(row?.size_bytes) };
      };
      return {
        dataPath: globalValue(metadata, 'data_path'),
        encrypted: globalValue(metadata, 'encrypted') === 'true',
        dataFiles: totalsOf('data'),
        deleteFiles: totalsOf('delete'),
        scheduledForDeletion,
        expirableSnapshots,
      };
    },
  };
}
