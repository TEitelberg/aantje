import type { ReportPort } from '../shell/report-port';
import { performSnapshotAction } from '../snapshot-changes/execute';
import type { GrowthPlan } from './actions';

/** Carries out a plan of the Growth report: the actions on a snapshot are those of the reports of snapshots. */
export const performGrowthAction = (plan: GrowthPlan, port: ReportPort): Promise<void> =>
  performSnapshotAction(plan, port, 'use the growth report');
