import { isArrayOf, isCount, isObject, isOneOf, isOptional, isShape, isString, own } from '../guards';
import { isSnapshot } from '../snapshot-report/protocol';
import { POINT_KINDS } from '../snapshot-report/model';
import { actionGuard } from '../shell/protocol';
import { isReportScope } from '../shell/scope';
import type { ACTION_IDS } from './actions';
import type { ActivityActionRequest } from './actions';
import type { ActivityMarkdownView } from './markdown';
import type { ActivityData } from './model';

/** A page request: an action of the detail pane by id, never a command. */
export type ActivityPageRequest = { readonly type: 'action' } & ActivityActionRequest;

type ActivityMessage = { readonly type: 'activity'; readonly data: ActivityData };

const isData = isShape({
  connection: isString,
  scope: isReportScope,
  latest: isCount,
  snapshots: isArrayOf(isSnapshot),
  more: (value) => typeof value === 'boolean',
  read: isOptional(isCount),
});

/** Guard for the messages the extension sends to the page. */
export function isActivityMessage(value: unknown): value is ActivityMessage {
  return isObject(value) && own(value, 'type') === 'activity' && isData(own(value, 'data'));
}

const FIELDS: Record<(typeof ACTION_IDS)[number], Record<string, (value: unknown) => boolean>> = {
  showSnapshotReport: {},
  showCatalog: { snapshot: isCount },
  rowsChanged: { snapshot: isCount, table: isCount },
  compareSnapshots: { snapshot: isCount, against: isOneOf('previous', 'latest') },
};

/** A known action with exactly its fields; `planActivityAction` checks that they name something sent. */
export const isActivityAction = actionGuard(FIELDS) as (value: unknown) => value is ActivityPageRequest;

/** The choices that Open as Markdown may name; the extension fits them to the data. */
export const isActivityView: (value: unknown) => value is ActivityMarkdownView = isShape({
  author: isOptional(isString),
  table: isOptional(isString),
  kinds: isArrayOf(isOneOf(...POINT_KINDS)),
  text: isString,
  range: isShape({ from: isCount, to: isCount }),
}) as (value: unknown) => value is ActivityMarkdownView;
