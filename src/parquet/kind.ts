import type { ReportKind } from '../shell/panels';
import { parquetMarkdown } from './markdown';
import type { ParquetData } from './model';
import { isParquetAction, isParquetView } from './protocol';
import type { ParquetAction, ParquetView } from './protocol';
import { PARQUET_CSS } from './style';

/** The Parquet inspector: one panel per file, with Refresh, Open as Markdown, Copy and the bloom filter probe. */
export const parquetKind: ReportKind<ParquetData, ParquetAction, ParquetView> = {
  viewType: 'aantje.parquet',
  css: PARQUET_CSS,
  message: (data) => ({ type: 'parquet', data }),
  isAction: isParquetAction,
  isView: isParquetView,
  toMarkdown: parquetMarkdown,
};
