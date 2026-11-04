import type { ReportKind } from '../shell/panels';
import { advisorMarkdown } from './markdown';
import type { AdvisorData } from './model';
import { isAdvisorAction } from './protocol';
import type { AdvisorAction } from './protocol';
import { ADVISOR_CSS } from './style';

/** The Maintenance Advisor kind: Refresh and the actions behind a recommendation; no filter, so no view. */
export const advisorKind: ReportKind<AdvisorData, AdvisorAction, never> = {
  viewType: 'aantje.advisor',
  css: ADVISOR_CSS,
  message: (data) => ({ type: 'advisor', data }),
  isAction: isAdvisorAction,
  toMarkdown: (data) => advisorMarkdown(data),
};
