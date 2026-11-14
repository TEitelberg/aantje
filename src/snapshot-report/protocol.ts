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
import type { SnapshotActionId, SnapshotActionRequest } from '../snapshot-changes/actions';
import { POINT_KINDS } from '../snapshot-changes/model';
import { WINDOW_FIELDS } from '../snapshot-changes/protocol';
import type { SnapshotReportMarkdownView } from './markdown';
import type { SnapshotReportData } from './model';

export type SnapshotReportPageRequest = { readonly type: 'action' } & SnapshotActionRequest;

const isAgainst = isOneOf('previous', 'latest', 'other');

type SnapshotReportMessage = { readonly type: 'snapshotReport'; readonly data: SnapshotReportData };

const isData = isShape(WINDOW_FIELDS);

export function isSnapshotReportMessage(value: unknown): value is SnapshotReportMessage {
  return isObject(value) && own(value, 'type') === 'snapshotReport' && isData(own(value, 'data'));
}

// The fields of each action; `other` goes with `against: 'other'` and only with it.
const ACTION_FIELDS: Readonly<Record<SnapshotActionId, Readonly<Record<string, Test>>>> = {
  showCatalog: { snapshot: isCount },
  showLatest: {},
  rowsChanged: { snapshot: isCount, table: isCount },
  compareSchema: { snapshot: isCount, table: isCount, against: isAgainst, other: isOptional(isCount) },
  compareSnapshots: { snapshot: isCount, against: isAgainst, other: isOptional(isCount) },
  query: { snapshot: isCount, table: isCount },
};

const hasAction = actionGuard(ACTION_FIELDS);

/** A known action with exactly its fields; `planAction` checks that they name sent data. */
export function isSnapshotReportAction(value: unknown): value is SnapshotReportPageRequest {
  return (
    hasAction(value) &&
    (!Object.hasOwn(ACTION_FIELDS[value.action], 'against') ||
      (own(value, 'against') === 'other') === (own(value, 'other') !== undefined))
  );
}

/** The page's choices for Open as Markdown; the extension fits them to the data. */
export const isSnapshotReportView: (value: unknown) => value is SnapshotReportMarkdownView = isExactShape({
  lanes: isArrayOf(isString),
  kinds: isArrayOf(isOneOf(...POINT_KINDS)),
  range: isShape({ from: isCount, to: isCount }),
}) as (value: unknown) => value is SnapshotReportMarkdownView;
