import type { ReportKind } from '../shell/panels';
import { activityMarkdown } from './markdown';
import type { ActivityMarkdownView } from './markdown';
import type { ActivityData } from './model';
import { isActivityAction, isActivityView } from './protocol';
import type { ActivityPageRequest } from './protocol';
import { ACTIVITY_CSS } from './style';

/** The Activity report kind: Refresh and the actions of the detail pane. */
export const activityKind: ReportKind<ActivityData, ActivityPageRequest, ActivityMarkdownView> = {
  viewType: 'aantje.activity',
  css: ACTIVITY_CSS,
  message: (data) => ({ type: 'activity', data }),
  isAction: isActivityAction,
  isView: isActivityView,
  toMarkdown: activityMarkdown,
};
