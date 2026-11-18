import { activityPage } from '../activity/page';
import { advisorPage } from '../advisor/page';
import { dashboardPage } from '../catalog-dashboard/page';
import { dependenciesPage } from '../dependencies/page';
import { detailsPage } from '../details/page';
import { growthPage } from '../growth/page';
import { healthPage } from '../health-report/page';
import { lastGoodPage } from '../health-report/last-good-page';
import { icebergPage } from '../iceberg-report/page';
import { inactivePage } from '../inactive-tables/page';
import { parquetPage } from '../parquet/page';
import { partitionPage } from '../partitioning/page';
import { propertiesPage } from '../properties-report/page';
import { snapshotReportPage } from '../snapshot-report/page';
import { schemaHistoryPage } from '../schema-history/page';
import { statisticsPage } from '../stats/page';
import { storagePage } from '../storage-report/page';
import { templatesPage } from '../templates/page';
import type { PageKind } from './page';

/** Every page the shell script can build: the reports and the Templates page. */
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
  icebergPage,
  detailsPage,
  templatesPage,
  dashboardPage,
  parquetPage,
  partitionPage,
  lastGoodPage,
  inactivePage,
];
