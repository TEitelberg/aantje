import { connectionClosed } from '../messages';
import type { ReportPort } from '../shell/report-port';
import type { ActivityPlan } from './actions';

const GOAL = 'use the activity report';

/** Carries out a plan of the Activity report: it opens the Snapshot report of the connection while that is open. */
export async function performActivityAction(
  plan: ActivityPlan,
  port: Pick<ReportPort, 'reader'>,
  open: Readonly<Record<ActivityPlan['action'], () => Promise<void>>>,
): Promise<void> {
  if (!port.reader()) {
    throw connectionClosed(GOAL);
  }
  await open[plan.action]();
}
