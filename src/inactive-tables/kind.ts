import type { ReportKind } from '../shell/panels';
import { inactiveMarkdown } from './markdown';
import type { InactiveData } from './model';
import { isInactiveAction } from './protocol';
import type { InactiveAction } from './protocol';
import { INACTIVE_CSS } from './style';

/** The Inactive Tables kind: Refresh, Open as Markdown, the days to read the tables for and the actions on a table. */
export const inactiveKind: ReportKind<InactiveData, InactiveAction, never> = {
  viewType: 'aantje.inactiveTables',
  css: INACTIVE_CSS,
  message: (data) => ({ type: 'inactiveTables', data }),
  isAction: isInactiveAction,
  toMarkdown: (data) => inactiveMarkdown(data),
};
