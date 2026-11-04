import type { ReportKind } from '../shell/panels';
import { snapshotReportMarkdown } from './markdown';
import type { SnapshotReportMarkdownView } from './markdown';
import type { SnapshotReportData } from './model';
import { isSnapshotReportAction, isSnapshotReportView } from './protocol';
import type { SnapshotReportPageRequest } from './protocol';
import { SNAPSHOT_REPORT_CSS } from './style';

export const snapshotReportKind: ReportKind<
  SnapshotReportData,
  SnapshotReportPageRequest,
  SnapshotReportMarkdownView
> = {
  viewType: 'aantje.snapshotReport',
  css: SNAPSHOT_REPORT_CSS,
  message: (data) => ({ type: 'snapshotReport', data }),
  isAction: isSnapshotReportAction,
  isView: isSnapshotReportView,
  toMarkdown: snapshotReportMarkdown,
};
