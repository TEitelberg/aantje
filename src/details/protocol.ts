import {
  isArrayOf,
  isBoolean,
  isCount,
  isExactShape,
  isNullOr,
  isObject,
  isOneOf,
  isOptional,
  isShape,
  isString,
  isTrue,
  own,
} from '../guards';
import type { Test } from '../guards';
import { actionGuard } from '../shell/protocol';
import type { ActionMessage } from '../shell/protocol';
import { isReportScope } from '../shell/scope';
import { OBJECT_COLUMN_KEYS, SORT_KEYS, TABS } from './model';
import type { DetailsData, DetailsView } from './model';

type DetailsMessage = { readonly type: 'details'; readonly data: DetailsData };

const isMark = isNullOr(isShape({ snapshot: isCount, time: isString }));

const BASE = {
  id: isCount,
  schemaId: isCount,
  schema: isString,
  name: isString,
  lastChange: isMark,
  created: isMark,
  dependsOn: isNullOr(isCount),
  usedBy: isNullOr(isCount),
};

const isDetailsObject = isShape({
  ...BASE,
  kind: isOneOf('table', 'view'),
  comment: isNullOr(isString),
  rows: isOptional(isCount),
  approximate: isOptional(isTrue),
  sizeBytes: isOptional(isCount),
  files: isOptional(isCount),
  smallFiles: isOptional(isCount),
  deleteFiles: isOptional(isCount),
  inlinedRows: isOptional(isNullOr(isCount)),
  partitioning: isOptional(isNullOr(isString)),
  sortOrder: isOptional(isNullOr(isString)),
});

const isDetailsMacro = isShape({
  ...BASE,
  kind: isOneOf('scalar', 'table'),
  overloads: isCount,
  parameters: isString,
});

const isData = isShape({
  connection: isString,
  scope: isReportScope,
  snapshot: isCount,
  readAt: isString,
  objects: isArrayOf(isDetailsObject),
  objectCount: isCount,
  macros: isArrayOf(isDetailsMacro),
  smallFileBytes: isCount,
  changesFrom: isNullOr(isCount),
  inlined: isOneOf('counted', 'older', 'failed', 'partial'),
  dependencies: isBoolean,
});

/** Guard for the messages the extension sends to the page. */
export function isDetailsMessage(value: unknown): value is DetailsMessage {
  return isObject(value) && own(value, 'type') === 'details' && isData(own(value, 'data'));
}

/** The choices of the page that Open as Markdown and Copy name; checked field by field, nothing else. */
export const isDetailsView = isExactShape({
  tab: isOneOf(...TABS.map(({ id }) => id)),
  filter: isString,
  sort: isExactShape({ key: isOneOf(...SORT_KEYS), descending: isBoolean }),
  columns: isArrayOf(isOneOf(...OBJECT_COLUMN_KEYS)),
}) as (value: unknown) => value is DetailsView;

/** The actions of a row, and Copy of the list. */
export type DetailsActionId =
  | 'showInTree'
  | 'preview'
  | 'showStatistics'
  | 'showSchemaHistory'
  | 'showDependencies'
  | 'scriptMerge'
  | 'scriptRewrite'
  | 'scriptFlush'
  | 'copy';

/** The kind of a row an action names: a table, a view or a macro, with its catalog id. */
export type RowKind = 'table' | 'view' | 'macro';

export type DetailsAction = ActionMessage & {
  readonly action: DetailsActionId;
  readonly kind?: RowKind;
  readonly id?: number;
  readonly view?: DetailsView;
};

const ROW: Readonly<Record<string, Test>> = { kind: isOneOf('table', 'view', 'macro'), id: isCount };

const ACTION_FIELDS: Readonly<Record<DetailsActionId, Readonly<Record<string, Test>>>> = {
  showInTree: ROW,
  preview: ROW,
  showStatistics: ROW,
  showSchemaHistory: ROW,
  showDependencies: ROW,
  scriptMerge: ROW,
  scriptRewrite: ROW,
  scriptFlush: ROW,
  copy: { view: isDetailsView },
};

/** A known action with a row (kind and id) or, for Copy, a view; the extension checks that the row was sent. */
export const isDetailsAction: (value: unknown) => value is DetailsAction = actionGuard(ACTION_FIELDS);
