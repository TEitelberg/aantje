import { connectionClosed } from '../messages';
import type { ReportPort } from '../shell/report-port';
import { performSnapshotAction } from '../snapshot-changes/execute';
import type { ActivityPlan } from './actions';

const GOAL = 'use the activity report';

/** Carries out a plan of the Activity report; the actions on a snapshot are those of the reports of snapshots. */
export async function performActivityAction(
  plan: ActivityPlan,
  port: ReportPort,
  showSnapshotReport: () => Promise<void>,
): Promise<void> {
  if (plan.action !== 'showSnapshotReport') {
    await performSnapshotAction(plan, port, GOAL);
    return;
  }
  if (!port.reader()) {
    throw connectionClosed(GOAL);
  }
  await showSnapshotReport();
}
