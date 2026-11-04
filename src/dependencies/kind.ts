import type { ReportKind } from '../shell/panels';
import { dependenciesMarkdown } from './markdown';
import type { DependenciesMarkdownView } from './markdown';
import type { DependenciesData } from './model';
import { isDependenciesAction, isDependenciesView } from './protocol';
import type { DependenciesAction } from './protocol';
import { DEPENDENCIES_CSS } from './style';

/** The Dependencies report kind: Refresh and the actions on the objects of its lists. */
export const dependenciesKind: ReportKind<DependenciesData, DependenciesAction, DependenciesMarkdownView> = {
  viewType: 'aantje.dependencies',
  css: DEPENDENCIES_CSS,
  message: (data) => ({ type: 'dependencies', data }),
  isAction: isDependenciesAction,
  isView: isDependenciesView,
  toMarkdown: dependenciesMarkdown,
};
