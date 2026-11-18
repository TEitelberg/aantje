import type { ReportKind } from '../shell/panels';
import { partitionMarkdown } from './markdown';
import type { PartitionData } from './model';
import { isPartitionAction } from './protocol';
import type { PartitionAction } from './protocol';
import { PARTITION_CSS } from './style';

/** Suggest Partitioning: one panel per connection and table, with Refresh, Open as Markdown and the scripts. */
export const partitionKind: ReportKind<PartitionData, PartitionAction, never> = {
  viewType: 'aantje.partitioning',
  css: PARTITION_CSS,
  message: (data) => ({ type: 'partitioning', data }),
  isAction: isPartitionAction,
  toMarkdown: (data) => partitionMarkdown(data),
};
