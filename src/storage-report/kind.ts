import type { ReportKind } from '../shell/panels';
import { storageMarkdown } from './markdown';
import type { StorageData, StorageView } from './model';
import { isStorageAction, isStorageView } from './protocol';
import type { StorageAction } from './protocol';
import { STORAGE_CSS } from './style';

/** The Storage report kind: Refresh and the actions of the lake and of a table. */
export const storageKind: ReportKind<StorageData, StorageAction, StorageView> = {
  viewType: 'aantje.storage',
  css: STORAGE_CSS,
  message: (data) => ({ type: 'storage', data }),
  isAction: isStorageAction,
  isView: isStorageView,
  toMarkdown: storageMarkdown,
};
