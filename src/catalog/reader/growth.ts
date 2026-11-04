import { parseChanges } from '../changes';
import type { Row } from '../drivers/driver';
import type { CatalogReader, GrowthChange, GrowthChanges, LakeGrowth } from '../model';
import * as queries from '../queries/growth';
import { INLINED_TABLE, inlinedTables } from '../queries/maintenance';
import { GROWTH_POINT_LIMIT, growth } from '../statistics';
import type { GrowthDelta } from '../statistics';
import { toIsoUtcOrNull, toNumber, toText, toTextOrNull } from './rows';
import type { Attempt, Run } from './rows';

// Inlined tables (one per table and schema version) whose rows `growthChanges` counts; the rest are left out.
const INLINED_GROWTH_TABLES = 200;

/**
 * Deltas from the rows of `growthDeltas` or `lakeGrowthDeltas`. A snapshot compacted only when `merge_adjacent` is an
 * entry of one of `tables` (a table id, or a set of them; every table when absent), not part of a table name.
 */
export function growthDeltasOf(rows: readonly Row[], tables?: number | ReadonlySet<number>): GrowthDelta[] {
  const wanted = (id: number | null): boolean =>
    tables === undefined || (typeof tables === 'number' ? id === tables : id !== null && tables.has(id));
  return rows.flatMap((row) => {
    const compaction = parseChanges(toTextOrNull(row.changes_made)).some(
      (entry) => entry.token === 'merge_adjacent' && wanted(entry.id),
    );
    return compaction || toNumber(row.changed) > 0
      ? [
          {
            snapshot: toNumber(row.snapshot_id),
            time: toIsoUtcOrNull(row.snapshot_time),
            files: toNumber(row.files),
            sizeBytes: toNumber(row.bytes),
            compaction,
          },
        ]
      : [];
  });
}

// Sums per table and snapshot; drops pairs that changed nothing (an inlined row replaced by a new version).
function sumChanges(rows: readonly Row[]): GrowthChange[] {
  const sums = new Map<string, GrowthChange>();
  for (const row of rows) {
    const tableId = toNumber(row.table_id);
    const at = toNumber(row.snapshot_id);
    const snapshot = at === queries.BEFORE_FIRST ? null : at;
    const key = `${tableId}:${snapshot ?? ''}`;
    const before = sums.get(key);
    sums.set(key, {
      tableId,
      snapshot,
      rows: (before?.rows ?? 0) + toNumber(row.rows_delta),
      sizeBytes: (before?.sizeBytes ?? 0) + toNumber(row.bytes_delta),
      files: (before?.files ?? 0) + toNumber(row.files_delta),
      partialFiles: (before?.partialFiles ?? 0) + toNumber(row.partial_delta),
    });
  }
  return [...sums.values()]
    .filter((c) => c.rows !== 0 || c.sizeBytes !== 0 || c.files !== 0 || c.partialFiles !== 0)
    .toSorted((a, b) => a.tableId - b.tableId || (a.snapshot ?? -1) - (b.snapshot ?? -1));
}

type GrowthReads = Pick<CatalogReader, 'lakeGrowth' | 'growthChanges'>;

/** Reads of how the files of the lake and its tables change from snapshot to snapshot. */
export function growthReads(run: Run, attempt: Attempt): GrowthReads {
  return {
    async lakeGrowth(snapshot, limit = GROWTH_POINT_LIMIT, signal, scope = {}): Promise<LakeGrowth> {
      const [rows, tables] = await Promise.all([
        run(queries.lakeGrowthDeltas(snapshot, scope), signal),
        scope.schemaId === undefined ? undefined : run(queries.schemaTableIds(scope.schemaId), signal),
      ]);
      const { points, merged } = growth(
        growthDeltasOf(rows, tables && new Set(tables.map((row) => toNumber(row.table_id)))),
        limit,
      );
      return { growth: points, ...(merged ? { growthMerged: true as const } : {}) };
    },

    async growthChanges(first, signal): Promise<GrowthChanges> {
      const found = (await attempt(inlinedTables({}, INLINED_GROWTH_TABLES + 1), signal)) ?? [];
      // The name is part of the statement: only names DuckLake writes are used.
      const inlined = found
        .slice(0, INLINED_GROWTH_TABLES)
        .map((row) => ({ tableId: toNumber(row.table_id), name: toText(row.table_name) }))
        .filter(({ name }) => INLINED_TABLE.test(name));
      const [files, rows] = await Promise.all([
        run(queries.growthChanges(first), signal),
        inlined.length === 0 ? [] : attempt(queries.inlinedGrowthChanges(inlined, first), signal),
      ]);
      return {
        changes: sumChanges([...files, ...(rows ?? [])]),
        ...(found.length > INLINED_GROWTH_TABLES ? { inlinedMore: true as const } : {}),
        // Rows of the data files are still counted.
        ...(rows === undefined ? { inlinedFailed: true as const } : {}),
      };
    },
  };
}
