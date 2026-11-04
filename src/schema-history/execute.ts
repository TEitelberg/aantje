import { alterTableTemplate } from '../script-templates/table';
import { performSnapshotReportAction as performOfReport } from '../snapshot-report/execute';
import type { ReportPort } from '../shell/report-port';
import type { SchemaHistoryPlan } from './actions';
import { connectionClosed } from '../messages';

/** Shared actions go to the snapshot report; the ALTER template opens in a SQL editor without running. */
export async function performSchemaHistoryAction(plan: SchemaHistoryPlan, port: ReportPort): Promise<void> {
  const reader = port.reader();
  if (!reader) {
    throw connectionClosed('use the schema history');
  }
  if (plan.action !== 'scriptAlter') {
    await performOfReport(plan, port);
    return;
  }
  const { subject } = plan;
  const { latestSnapshot } = await reader.info();
  await port.openSql(
    alterTableTemplate(
      subject.schemaName,
      subject.name,
      await reader.columns(subject.id, latestSnapshot),
      undefined,
    ),
  );
}
