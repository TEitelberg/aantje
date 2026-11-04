import type { ReportKind } from '../shell/panels';
import { growthMarkdown } from './markdown';
import type { GrowthMarkdownView } from './markdown';
import type { GrowthData } from './model';
import { isGrowthAction, isGrowthView } from './protocol';
import type { GrowthPageRequest } from './protocol';
import { GROWTH_CSS } from './style';

export const growthKind: ReportKind<GrowthData, GrowthPageRequest, GrowthMarkdownView> = {
  viewType: 'aantje.growth',
  css: GROWTH_CSS,
  message: (data) => ({ type: 'growth', data }),
  isAction: isGrowthAction,
  isView: isGrowthView,
  toMarkdown: growthMarkdown,
};
