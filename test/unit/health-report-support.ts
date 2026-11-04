import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { finding } from '../../src/health/finding';
import type { CheckId, FindingScope, HealthEvent, HealthFinding, HealthReport } from '../../src/health/model';
import { applyEvents, freshData } from '../../src/health-report/model';
import type { HealthData, PanelEvent } from '../../src/health-report/model';
import { checkFixture, editCatalog, lake } from './health-support';
import { copyHistoryFixture } from './history-support';

/** The events that a run reports and the data a panel holds when they are applied, the way the extension does it. */
export function dataFromReport(
  report: HealthReport,
  events: readonly HealthEvent[],
  connection = 'History lake',
  scope: FindingScope = { kind: 'lake' },
  normalize: (text: string) => string = (text) => text,
): HealthData {
  const choice = { depth: report.request.depth, deepFiles: 200 } as const;
  const all: PanelEvent[] = [
    ...events,
    ...(report.snapshot === undefined ? [] : [{ type: 'snapshot' as const, snapshot: report.snapshot }]),
  ];
  const data = applyEvents(freshData(connection, scope, choice, 'running'), all);
  // The time a run took is the one thing that differs from run to run; the path of the temporary directory too.
  return JSON.parse(
    normalize(
      JSON.stringify({ ...data, ...(data.summary ? { summary: { ...data.summary, elapsedMs: 1500 } } : {}) }),
    ),
  ) as HealthData;
}

/** A run of the check on a private copy of the history fixture; `change` breaks the copy first. */
export async function runOnHistory(
  change?: (directory: string, fixture: Awaited<ReturnType<typeof copyHistoryFixture>>) => Promise<void>,
  depth: 'quick' | 'deep' = 'quick',
): Promise<HealthData> {
  const fixture = await copyHistoryFixture('sqlite');
  try {
    await change?.(fixture.directory, fixture);
    const events: HealthEvent[] = [];
    const report = await checkFixture(
      fixture,
      { scope: lake, depth },
      {},
      {},
      { onEvent: (event) => events.push(event) },
    );
    const where = fixture.directory.replaceAll('\\', '/');
    return dataFromReport(report, events, 'History lake', lake, (text) => text.replaceAll(where, '/lake'));
  } finally {
    await fixture.remove();
  }
}

export const EVENTS_FILE =
  'shop/events/kind=click/year=2025/ducklake-01a18cd6-3c4f-7d55-94b2-e4f075f8b0d6.parquet';

/** The history fixture with the Parquet file of a table gone and a negative row count in the catalog. */
export const breakHistory = async (
  directory: string,
  fixture: Awaited<ReturnType<typeof copyHistoryFixture>>,
): Promise<void> => {
  rmSync(join(directory, 'sqlite-files', EVENTS_FILE));
  await editCatalog(fixture, [
    'UPDATE meta.ducklake_data_file SET record_count = -5 WHERE data_file_id = (SELECT min(data_file_id) FROM meta.ducklake_data_file WHERE end_snapshot IS NULL)',
  ]);
};

/** A finding of any check, with texts that do not depend on a catalog. */
export function sampleFinding(
  check: CheckId,
  severity: HealthFinding['severity'],
  scope: FindingScope,
  extra: Partial<
    Pick<
      HealthFinding,
      'inspectSql' | 'settingKey' | 'objectKey' | 'suggestion' | 'title' | 'detail' | 'cause' | 'fix'
    >
  > & {
    object?: string;
  } = {},
): HealthFinding {
  const { object, ...rest } = extra;
  return finding(check, {
    severity,
    scope,
    ...(object === undefined ? {} : { object }),
    title: rest.title ?? `Title of ${check}`,
    detail: rest.detail ?? `Detail of ${check}`,
    cause: rest.cause ?? `Cause of ${check}`,
    fix: rest.fix ?? `Fix of ${check}`,
    ...(rest.inspectSql === undefined ? {} : { inspectSql: rest.inspectSql }),
    ...(rest.settingKey === undefined ? {} : { settingKey: rest.settingKey }),
    ...(rest.objectKey === undefined ? {} : { objectKey: rest.objectKey }),
    ...(rest.suggestion === undefined ? {} : { suggestion: rest.suggestion }),
  });
}

export const events = { kind: 'table', id: 3, schema: 'shop', name: 'events' } as const;
export const customers = { kind: 'table', id: 4, schema: 'shop', name: 'customers' } as const;

/**
 * The values of a health document without its prose: the headings, the table rows, the findings by id in order, how
 * many Detail, Cause and Fix lines there are, and the SQL statements (comment lines left out).
 */
export function documentShape(document: string): {
  headings: string[];
  rows: string[];
  findings: string[];
  explained: number;
  sql: string[];
} {
  const lines = document.split('\n');
  let fenced = false;
  const sql: string[] = [];
  for (const line of lines) {
    if (line.startsWith('```')) {
      fenced = line === '```sql';
    } else if (fenced && !line.startsWith('--') && line.trim() !== '') {
      sql.push(line);
    }
  }
  return {
    headings: lines.filter((line) => line.startsWith('#')),
    rows: lines.filter((line) => line.startsWith('|')),
    findings: lines.flatMap((line) => /^`([a-z-]+\.[a-z-]+)`, group /.exec(line)?.[1] ?? []),
    explained: lines.filter((line) => /^- (Detail|Cause|Fix): /.test(line)).length,
    sql,
  };
}
