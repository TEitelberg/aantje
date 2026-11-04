import type { ReportKind } from '../shell/panels';
import { healthMarkdown } from './markdown';
import type { HealthData, HealthFilter } from './model';
import { isHealthAction, isHealthView } from './protocol';
import type { HealthAction } from './protocol';
import { HEALTH_CSS } from './style';

/** The Health check: the page runs the check (Run, Cancel), filters its findings and acts on them. It has no Refresh. */
export const healthKind: ReportKind<HealthData, HealthAction, HealthFilter> = {
  viewType: 'aantje.health',
  css: HEALTH_CSS,
  message: (data) => ({ type: 'health', data }),
  isAction: isHealthAction,
  isView: isHealthView,
  toMarkdown: healthMarkdown,
};
