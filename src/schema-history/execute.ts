import { connectionClosed } from '../messages';
import { alterTableTemplate } from '../script-templates/table';
import type { ReportPort } from '../shell/report-port';
import { performSnapshotAction } from '../snapshot-changes/execute';
import type { SchemaHistoryPlan } from './actions';

const GOAL = 'use the schema history';

/** The actions on a snapshot are those of the reports of snapshots; the ALTER template opens in a SQL editor without running. */
export async function performSchemaHistoryAction(plan: SchemaHistoryPlan, port: ReportPort): Promise<void> {
  if (plan.action !== 'scriptAlter') {
    await performSnapshotAction(plan, port, GOAL);
    return;
  }
  const reader = port.reader();
  if (!reader) {
    throw connectionClosed(GOAL);
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
