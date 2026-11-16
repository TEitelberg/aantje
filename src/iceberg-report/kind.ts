import type { ReportKind } from '../shell/panels';
import type { IcebergData } from './model';
import { isIcebergAction } from './protocol';
import type { IcebergAction } from './protocol';
import { ICEBERG_CSS } from './style';

/** The Iceberg report has no Open as Markdown; its header offers the copy and Forget Sync. */
export const icebergKind: ReportKind<IcebergData, IcebergAction, never> = {
  viewType: 'aantje.iceberg',
  css: ICEBERG_CSS,
  message: (data) => ({ type: 'iceberg', data }),
  isAction: isIcebergAction,
};
