import type { ReportKind } from '../shell/panels';
import { schemaHistoryMarkdown } from './markdown';
import type { SchemaHistoryMarkdownView } from './markdown';
import type { SchemaHistoryData } from './model';
import { isSchemaHistoryAction, isSchemaHistoryView } from './protocol';
import type { SchemaHistoryPageRequest } from './protocol';
import { HISTORY_CSS } from './style';

export const schemaHistoryKind: ReportKind<
  SchemaHistoryData,
  SchemaHistoryPageRequest,
  SchemaHistoryMarkdownView
> = {
  viewType: 'aantje.schemaHistory',
  css: HISTORY_CSS,
  message: (data) => ({ type: 'schemaHistory', data }),
  isAction: isSchemaHistoryAction,
  isView: isSchemaHistoryView,
  toMarkdown: schemaHistoryMarkdown,
};
