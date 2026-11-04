import { activityPage } from '../activity/page';
import { advisorPage } from '../advisor/page';
import { dependenciesPage } from '../dependencies/page';
import { growthPage } from '../growth/page';
import { healthPage } from '../health-report/page';
import { propertiesPage } from '../properties-report/page';
import { snapshotReportPage } from '../snapshot-report/page';
import { schemaHistoryPage } from '../schema-history/page';
import { statisticsPage } from '../stats/page';
import { storagePage } from '../storage-report/page';
import type { PageKind } from './page';

/** Every report page the shell script can build. */
export const pageKinds: readonly PageKind<unknown>[] = [
  statisticsPage,
  snapshotReportPage,
  propertiesPage,
  schemaHistoryPage,
  activityPage,
  storagePage,
  healthPage,
  advisorPage,
  dependenciesPage,
  growthPage,
];
