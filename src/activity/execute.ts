import { performSnapshotReportAction as performOfReport } from '../snapshot-report/execute';
import type { ReportPort } from '../shell/report-port';
import type { ActivityPlan } from './actions';
import { connectionClosed } from '../messages';

/** Carries out a plan of the Activity report; most actions are the snapshot report's. */
export async function performActivityAction(
  plan: ActivityPlan,
  port: ReportPort,
  showSnapshotReport: () => Promise<void>,
): Promise<void> {
  if (!port.reader()) {
    throw connectionClosed('use the activity report');
  }
  if (plan.action === 'showSnapshotReport') {
    await showSnapshotReport();
  } else {
    await performOfReport(plan, port);
  }
}
