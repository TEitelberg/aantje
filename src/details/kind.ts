import type { ReportKind } from '../shell/panels';
import { detailsMarkdown } from './markdown';
import type { DetailsData, DetailsView } from './model';
import { isDetailsAction, isDetailsView } from './protocol';
import type { DetailsAction } from './protocol';
import { DETAILS_CSS } from './style';

/** The Details report kind: Refresh, Open as Markdown, Copy and the actions of a row. */
export const detailsKind: ReportKind<DetailsData, DetailsAction, DetailsView> = {
  viewType: 'aantje.details',
  css: DETAILS_CSS,
  message: (data) => ({ type: 'details', data }),
  isAction: isDetailsAction,
  isView: isDetailsView,
  toMarkdown: detailsMarkdown,
};
