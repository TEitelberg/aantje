import type { ReportKind } from '../shell/panels';
import { statisticsMarkdown } from './markdown';
import type { StatisticsData } from './model';
import { STATS_CSS } from './style';

/** The statistics report kind: it only asks for its data, with no action, refresh or view. */
export const statisticsKind: ReportKind<StatisticsData, never, never> = {
  viewType: 'aantje.statistics',
  css: STATS_CSS,
  message: (data) => ({ type: 'statistics', data }),
  toMarkdown: (data) => statisticsMarkdown(data),
};
