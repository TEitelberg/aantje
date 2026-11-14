import {
  isArrayOf,
  isCount,
  isExactShape,
  isObject,
  isOneOf,
  isOptional,
  isShape,
  isString,
  own,
} from '../guards';
import type { Test } from '../guards';
import { actionGuard } from '../shell/protocol';
import { POINT_KINDS } from '../snapshot-changes/model';
import { SCOPED_WINDOW_FIELDS } from '../snapshot-changes/protocol';
import type { ActivityActionId, ActivityActionRequest } from './actions';
import type { ActivityMarkdownView } from './markdown';
import type { ActivityData } from './model';

/** A page request: an action of the detail pane by id, never a command. */
export type ActivityPageRequest = { readonly type: 'action' } & ActivityActionRequest;

type ActivityMessage = { readonly type: 'activity'; readonly data: ActivityData };

const isData = isShape(SCOPED_WINDOW_FIELDS);

/** Guard for the messages the extension sends to the page. */
export function isActivityMessage(value: unknown): value is ActivityMessage {
  return isObject(value) && own(value, 'type') === 'activity' && isData(own(value, 'data'));
}

const FIELDS: Readonly<Record<ActivityActionId, Readonly<Record<string, Test>>>> = {
  showSnapshotReport: {},
  showCatalog: { snapshot: isCount },
  rowsChanged: { snapshot: isCount, table: isCount },
  compareSnapshots: { snapshot: isCount, against: isOneOf('previous', 'latest') },
};

/** A known action with exactly its fields; `planActivityAction` checks that they name something sent. */
export const isActivityAction: (value: unknown) => value is ActivityPageRequest = actionGuard(FIELDS);

/** The choices that Open as Markdown may name; the extension fits them to the data. */
export const isActivityView: (value: unknown) => value is ActivityMarkdownView = isExactShape({
  author: isOptional(isString),
  table: isOptional(isString),
  kinds: isArrayOf(isOneOf(...POINT_KINDS)),
  text: isString,
  range: isShape({ from: isCount, to: isCount }),
}) as (value: unknown) => value is ActivityMarkdownView;
