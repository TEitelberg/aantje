// The tools table_statistics and maintenance_advice: the data of the Statistics report of a table and of the
// Maintenance Advisor of a lake or schema, as aantje's reports read them. Free of the VS Code API.
import * as z from 'zod';
import { recommendationsOf } from '../advisor/recommend';
import { readAdvisor } from '../advisor/read';
import type { AdvisorData, Measured } from '../advisor/model';
import type { TableStatistics } from '../catalog/model';
import type { DataAccess } from '../data/types';
import { MAINTENANCE_LABEL } from '../maintenance/labels';
import { LAKE_SCOPE } from '../shell/scope';
import { named, schemaOf, ToolError } from './catalog';
import type { OpenCatalog } from './catalog';

const text = z.string();
const PATH = z.array(text);

export const STATISTICS = z.object({
  connection: text,
  snapshot: z.number(),
  schema: text,
  table: text,
  rows: z.number(),
  rowsApproximate: z.boolean(),
  dataFiles: z.number(),
  deleteFiles: z.number(),
  dataBytes: z.number(),
  deleteBytes: z.number(),
  largestFileBytes: z.number(),
  smallFiles: z.number(),
  smallFileBelowBytes: z.number(),
  fileSizes: z.array(
    z.object({ fromBytes: z.number(), toBytes: z.number(), files: z.number(), sizeBytes: z.number() }),
  ),
  partitioning: z
    .object({
      keys: z.array(z.object({ column: PATH, transform: text })),
      largestPartitions: z.array(
        z.object({
          values: z.array(text.nullable()),
          files: z.number(),
          sizeBytes: z.number(),
          rows: z.number(),
        }),
      ),
      otherPartitions: z
        .object({ partitions: z.number(), files: z.number(), sizeBytes: z.number(), rows: z.number() })
        .nullable(),
      evenness: z.object({ coefficientOfVariation: z.number(), gini: z.number() }).nullable(),
      filesOfEarlierPartitioning: z.number(),
      partial: z.boolean(),
      unread: z.boolean(),
    })
    .nullable(),
  columns: z.array(
    z.object({
      path: PATH,
      ducklakeType: text,
      nullable: z.boolean(),
      nullRatio: z.number().nullable(),
      min: text.nullable(),
      max: text.nullable(),
    }),
  ),
  columnStatisticsPartial: z.boolean(),
  columnStatisticsUnread: z.boolean(),
  growth: z.array(
    z.object({
      snapshot: z.number(),
      time: text.nullable(),
      files: z.number(),
      sizeBytes: z.number(),
      compaction: z.boolean(),
    }),
  ),
  growthMerged: z.boolean(),
});

type Statistics = z.infer<typeof STATISTICS>;

function partitioningOf(statistics: TableStatistics): Statistics['partitioning'] {
  const partitioning = statistics.partitioning;
  if (!partitioning) return null;
  return {
    keys: partitioning.partitioning.columns.map(({ path, transform }) => ({ column: [...path], transform })),
    largestPartitions: partitioning.partitions.map(({ values, files, sizeBytes, rows }) => ({
      values: [...values],
      files,
      sizeBytes,
      rows,
    })),
    otherPartitions: partitioning.rest ?? null,
    evenness: partitioning.evenness,
    filesOfEarlierPartitioning: partitioning.earlierFiles,
    partial: partitioning.partial === true,
    unread: partitioning.unread === true,
  };
}

/** The statistics of a table at the snapshot of the explorer, as the Statistics report shows them. */
export async function tableStatistics(
  catalog: OpenCatalog,
  table: { readonly schema: string; readonly table: string },
  signal: AbortSignal,
): Promise<Statistics> {
  const { reader, snapshot } = catalog;
  const schema = await schemaOf(catalog, table.schema);
  const found = named(await reader.tables(schema.id, snapshot), table.table);
  const [info] = found;
  if (!info || found.length > 1) {
    throw new ToolError(
      found.length > 1
        ? `Several tables of "${schema.name}" are named "${table.table}" apart from upper and lower case; use the exact spelling.`
        : `The schema "${schema.name}" has no table "${table.table}" at snapshot ${snapshot}.`,
    );
  }
  const statistics = await reader.tableStatistics(info.id, snapshot, signal);
  return {
    connection: catalog.profile.name,
    snapshot,
    schema: schema.name,
    table: info.name,
    rows: statistics.rows,
    rowsApproximate: statistics.approximate === true,
    dataFiles: statistics.files,
    deleteFiles: statistics.deleteFiles,
    dataBytes: statistics.dataBytes,
    deleteBytes: statistics.deleteBytes,
    largestFileBytes: statistics.largestFileBytes,
    smallFiles: statistics.smallFiles,
    smallFileBelowBytes: statistics.smallFileBytes,
    fileSizes: statistics.sizeHistogram.map((bin) => ({ ...bin })),
    partitioning: partitioningOf(statistics),
    columns: statistics.columns.map((column) => ({
      path: [...column.path],
      ducklakeType: column.type,
      nullable: column.nullable,
      nullRatio: column.nullRatio,
      min: column.min,
      max: column.max,
    })),
    columnStatisticsPartial: statistics.columnsPartial === true,
    columnStatisticsUnread: statistics.columnsUnread === true,
    growth: statistics.growth.map((point) => ({ ...point })),
    growthMerged: statistics.growthMerged === true,
  };
}

const LEVEL = z.enum(['low', 'medium', 'high']);
const measured = <T extends z.ZodType>(value: T) =>
  z.object({ state: z.enum(['measured', 'skipped']), reason: text.optional(), value: value.optional() });

export const ADVICE = z.object({
  connection: text,
  /** Null for the whole lake. */
  schema: text.nullable(),
  /** The newest snapshot: the advisor reads the newest state, whatever snapshot the explorer shows. */
  snapshot: z.number(),
  policy: z.object({
    expireOlderThan: text,
    expireOlderThanFrom: z.enum(['option', 'default']),
    deleteOlderThan: text.nullable(),
    rewriteDeleteThreshold: z.number(),
    targetFileSizeBytes: z.number(),
    unreadableOptions: z.array(text),
  }),
  dryRuns: z.object({
    expireSnapshots: measured(
      z.object({
        snapshots: z.number(),
        expiring: z.number(),
        oldest: text.nullable(),
        newest: text.nullable(),
      }),
    ),
    cleanUpOldFiles: measured(z.object({ files: z.number(), bytes: z.number(), sized: z.number() })),
    deleteOrphanedFiles: measured(z.object({ files: z.number(), bytes: z.number(), sized: z.number() })),
  }),
  scheduledForDeletion: z.number(),
  recommendations: z.array(
    z.object({
      script: text,
      schema: text.nullable(),
      table: text.nullable(),
      title: text,
      explanation: z.array(text),
      figures: z.array(z.object({ label: text, value: text })),
      impact: LEVEL,
      effort: LEVEL,
      risk: LEVEL,
    }),
  ),
  listsCut: z.boolean(),
  inlinedRowsUnread: z.boolean(),
});

type Advice = z.infer<typeof ADVICE>;

const dryRun = <T>(measure: Measured<T>): { state: 'measured' | 'skipped'; reason?: string; value?: T } =>
  measure.state === 'measured'
    ? { state: 'measured', value: measure.value }
    : { state: 'skipped', reason: measure.reason };

function adviceOf(data: AdvisorData, schema: string | null): Advice {
  const { policy } = data;
  return {
    connection: data.connection,
    schema,
    snapshot: data.snapshot,
    policy: {
      expireOlderThan: policy.expire.text,
      expireOlderThanFrom: policy.expire.source,
      deleteOlderThan: policy.delete,
      rewriteDeleteThreshold: policy.rewrite.share,
      targetFileSizeBytes: policy.target.bytes,
      unreadableOptions: [...policy.unreadable],
    },
    dryRuns: {
      expireSnapshots: dryRun(data.expiry),
      cleanUpOldFiles: dryRun(data.cleanup),
      deleteOrphanedFiles: dryRun(data.orphans),
    },
    scheduledForDeletion: data.scheduled.count,
    recommendations: recommendationsOf(data).map((recommendation) => ({
      script: MAINTENANCE_LABEL[recommendation.kind],
      schema: recommendation.table?.schema ?? null,
      table: recommendation.table?.name ?? null,
      title: recommendation.title,
      explanation: [...recommendation.explanation],
      figures: recommendation.figures.map(([label, value]) => ({ label, value })),
      impact: recommendation.impact,
      effort: recommendation.effort,
      risk: recommendation.risk,
    })),
    listsCut: data.more === true,
    inlinedRowsUnread: data.inlinedFailed === true,
  };
}

/**
 * The Maintenance Advisor of the lake or of one schema: the dry runs of Expire Snapshots, Clean Up Old Files and
 * Delete Orphaned Files, and the recommendations. It changes nothing.
 */
export async function maintenanceAdvice(
  catalog: OpenCatalog,
  access: DataAccess,
  schema: string | undefined,
  now: Date,
  signal: AbortSignal,
): Promise<Advice> {
  const scoped = schema === undefined ? undefined : await schemaOf(catalog, schema);
  const scope = scoped ? ({ kind: 'schema', id: scoped.id, name: scoped.name } as const) : LAKE_SCOPE;
  const data = await readAdvisor(
    { reader: catalog.reader, access },
    catalog.profile.name,
    now,
    signal,
    scope,
  );
  return adviceOf(data, scoped?.name ?? null);
}
