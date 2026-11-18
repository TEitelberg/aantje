import { parquetMarkdown } from './markdown';
import type { ParquetData, ParquetTarget } from './model';
import type { ParquetAction } from './protocol';

export type ParquetPlan =
  | { readonly action: 'probe'; readonly column: { readonly index: number; readonly path: string } }
  | { readonly action: 'copy'; readonly markdown: string }
  | { readonly action: 'open'; readonly target: ParquetTarget };

/**
 * The plan of a request, checked against the data: a probe only of a column with a bloom filter of a file that was read,
 * another file only one of the data files that the panel lists.
 */
export function planParquetAction(data: ParquetData, message: ParquetAction): ParquetPlan | undefined {
  if (message.action === 'openFile') {
    const choice = data.files?.find((entry) => entry.target.lake?.fileId === message.file);
    return choice ? { action: 'open', target: choice.target } : undefined;
  }
  const index = message.column ?? 0;
  const column = data.columns[index];
  if (message.action === 'copy') {
    return column || data.columns.length === 0
      ? { action: 'copy', markdown: parquetMarkdown(data, { column: index }) }
      : undefined;
  }
  return data.state === 'read' && column?.bloomFilter
    ? { action: 'probe', column: { index, path: column.path } }
    : undefined;
}
