import {
  isArrayOf,
  isCount,
  isNullOr,
  isObject,
  isOneOf,
  isOptional,
  isShape,
  isString,
  own,
} from '../guards';
import type { Test } from '../guards';
import type { ChangeObject } from '../catalog/changes';
import type { ResolvedAction } from '../catalog/model';
import { actionGuard } from '../shell/protocol';
import type { SnapshotReportActionId, SnapshotReportActionRequest } from './actions';
import type { SnapshotReportMarkdownView } from './markdown';
import { POINT_KINDS } from './model';
import type { SnapshotReportData } from './model';

export type SnapshotReportPageRequest = { readonly type: 'action' } & SnapshotReportActionRequest;

const isAgainst = isOneOf('previous', 'latest', 'other');

type SnapshotReportMessage = { readonly type: 'snapshotReport'; readonly data: SnapshotReportData };

// Keyed by every action and object, so the compiler flags a new one; an unlisted value rejects the message.
const CHANGE_ACTIONS: Readonly<Record<ResolvedAction, true>> = {
  created: true,
  dropped: true,
  altered: true,
  renamed: true,
  inserted: true,
  deleted: true,
  inlined_insert: true,
  inlined_delete: true,
  flushed_inlined: true,
  compacted: true,
  merged: true,
  rewritten: true,
  expired: true,
  unknown: true,
};
const CHANGE_OBJECTS: Readonly<Record<ChangeObject, true>> = {
  schema: true,
  table: true,
  view: true,
  scalar_macro: true,
  table_macro: true,
  snapshot_tag: true,
  snapshot: true,
};

const isChange = isShape({
  action: isOneOf(...Object.keys(CHANGE_ACTIONS)),
  object: isNullOr(isOneOf(...Object.keys(CHANGE_OBJECTS))),
  objectId: isNullOr(isCount),
  schemaName: isNullOr(isString),
  name: isNullOr(isString),
  raw: isString,
});

/** Shared with the Activity report. */
export const isSnapshot = isShape({
  id: isCount,
  time: isString,
  author: isNullOr(isString),
  commitMessage: isNullOr(isString),
  changes: isArrayOf(isChange),
});

const isData = isShape({
  connection: isString,
  latest: isCount,
  snapshots: isArrayOf(isSnapshot),
  more: (value) => typeof value === 'boolean',
});

export function isSnapshotReportMessage(value: unknown): value is SnapshotReportMessage {
  return isObject(value) && own(value, 'type') === 'snapshotReport' && isData(own(value, 'data'));
}

// The fields of each action; `other` goes with `against: 'other'` and only with it.
const ACTION_FIELDS: Readonly<Record<SnapshotReportActionId, Readonly<Record<string, Test>>>> = {
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
export const isSnapshotReportView: (value: unknown) => value is SnapshotReportMarkdownView = isShape({
  lanes: isArrayOf(isString),
  kinds: isArrayOf(isOneOf(...POINT_KINDS)),
  range: isShape({ from: isCount, to: isCount }),
}) as (value: unknown) => value is SnapshotReportMarkdownView;
