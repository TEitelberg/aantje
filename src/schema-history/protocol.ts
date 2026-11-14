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
  own,
} from '../guards';
import type { Test } from '../guards';
import { actionGuard } from '../shell/protocol';
import type { SchemaHistoryActionId, SchemaHistoryActionRequest } from './actions';
import type { SchemaHistoryMarkdownView } from './markdown';
import { CELL_KINDS } from './model';
import type { SchemaHistoryData } from './model';

export type SchemaHistoryPageRequest = { readonly type: 'action' } & SchemaHistoryActionRequest;

type SchemaHistoryMessage = { readonly type: 'schemaHistory'; readonly data: SchemaHistoryData };

const isKind = isOneOf(...CELL_KINDS);

const isCell = isShape({ snapshot: isCount, kind: isKind, text: isString });

const isEvent = isShape({
  kind: isOneOf('created', 'renamed', 'dropped'),
  name: isString,
  from: isNullOr(isString),
});

const isSnapshot = isShape({
  id: isCount,
  time: isNullOr(isString),
  author: isNullOr(isString),
  message: isNullOr(isString),
  events: isArrayOf(isEvent),
  previous: isNullOr(isCount),
  exists: isBoolean,
});

const isColumn = isShape({
  id: isCount,
  parent: isNullOr(isCount),
  path: isArrayOf(isString),
  formerNames: isArrayOf(isString),
  now: isNullOr(isString),
  cells: isArrayOf(isCell),
});

const isData = isShape({
  connection: isString,
  tableId: isCount,
  schema: isNullOr(isString),
  name: isString,
  latest: isCount,
  exists: isBoolean,
  more: isBoolean,
  snapshots: isArrayOf(isSnapshot),
  columns: isArrayOf(isColumn),
});

export function isSchemaHistoryMessage(value: unknown): value is SchemaHistoryMessage {
  return isObject(value) && own(value, 'type') === 'schemaHistory' && isData(own(value, 'data'));
}

// The fields of each action; `against` goes with the comparison only.
const ACTION_FIELDS: Readonly<Record<SchemaHistoryActionId, Readonly<Record<string, Test>>>> = {
  showCatalog: { snapshot: isCount },
  compareSchema: { snapshot: isCount, against: isOneOf('previous', 'latest') },
  query: { snapshot: isCount },
  scriptAlter: {},
};

/** A known action with exactly its fields; `planAction` checks that they name sent data. */
export const isSchemaHistoryAction = actionGuard(ACTION_FIELDS) as (
  value: unknown,
) => value is SchemaHistoryPageRequest;

/** The page's choices for Open as Markdown; the extension fits them to the data. */
export const isSchemaHistoryView: (value: unknown) => value is SchemaHistoryMarkdownView = isExactShape({
  kinds: isArrayOf(isKind),
  text: isString,
  range: isOptional(isShape({ from: isCount, to: isCount })),
}) as (value: unknown) => value is SchemaHistoryMarkdownView;
