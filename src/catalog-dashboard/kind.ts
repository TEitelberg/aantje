import type { ReportKind } from '../shell/panels';
import { dashboardMarkdown } from './markdown';
import type { DashboardData } from './model';
import { isDashboardAction } from './protocol';
import type { DashboardAction } from './protocol';
import { DASHBOARD_CSS } from './style';

/** The Catalog Dashboard kind: Refresh, Open as Markdown and the VACUUM scripts of its findings. */
export const dashboardKind: ReportKind<DashboardData, DashboardAction, never> = {
  viewType: 'aantje.catalogDashboard',
  css: DASHBOARD_CSS,
  message: (data) => ({ type: 'catalogDashboard', data }),
  isAction: isDashboardAction,
  toMarkdown: (data) => dashboardMarkdown(data),
};
