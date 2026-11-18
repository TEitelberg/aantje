// The templates that ship with aantje, DuckLake first, then generic ones of plain DuckDB SQL for any table. Each is a
// template file in `builtin/`, bundled as text; a unit test runs every one of them, filled with sample values, against
// a DuckLake of the DuckDB version of aantje.
import addDataFiles from './builtin/add-data-files.sql';
import commitMessage from './builtin/commit-message.sql';
import compareTables from './builtin/compare-tables.sql';
import dataFreshness from './builtin/data-freshness.sql';
import duplicateKeys from './builtin/duplicate-keys.sql';
import expireCleanup from './builtin/expire-cleanup.sql';
import flushInlined from './builtin/flush-inlined.sql';
import mergeUpsert from './builtin/merge-upsert.sql';
import missingDays from './builtin/missing-days.sql';
import orphanedRows from './builtin/orphaned-rows.sql';
import outliersZScore from './builtin/outliers-z-score.sql';
import partitionedTable from './builtin/partitioned-table.sql';
import pivotMeasure from './builtin/pivot-measure.sql';
import removeDuplicates from './builtin/remove-duplicates.sql';
import restoreTable from './builtin/restore-table.sql';
import runningTotal from './builtin/running-total.sql';
import tableAtTime from './builtin/table-at-time.sql';
import tableAtVersion from './builtin/table-at-version.sql';
import tableChanges from './builtin/table-changes.sql';
import topNPerGroup from './builtin/top-n-per-group.sql';
import example from './example.sql';
import { fieldsOf, normalizedText } from './model';
import type { Template } from './model';

// The first four are the start of the page before any template was used.
const TEXTS: readonly (readonly [string, string])[] = [
  ['partitioned-table', partitionedTable],
  ['merge-upsert', mergeUpsert],
  ['table-changes', tableChanges],
  ['table-at-version', tableAtVersion],
  ['expire-cleanup', expireCleanup],
  ['restore-table', restoreTable],
  ['table-at-time', tableAtTime],
  ['add-data-files', addDataFiles],
  ['commit-message', commitMessage],
  ['flush-inlined', flushInlined],
  ['duplicate-keys', duplicateKeys],
  ['remove-duplicates', removeDuplicates],
  ['orphaned-rows', orphanedRows],
  ['compare-tables', compareTables],
  ['missing-days', missingDays],
  ['data-freshness', dataFreshness],
  ['top-n-per-group', topNPerGroup],
  ['running-total', runningTotal],
  ['pivot-measure', pivotMeasure],
  ['outliers-z-score', outliersZScore],
];

/** The built-in templates, in the order of the page. */
export const BUILTIN_TEMPLATES: readonly Template[] = TEXTS.map(([slug, raw]) => {
  const text = normalizedText(raw);
  return { id: `builtin-${slug}`, source: 'builtin', text, ...fieldsOf(text) };
});

/** The example of Download example: every field of the header filled in and explained. */
export const EXAMPLE_TEMPLATE = normalizedText(example);
