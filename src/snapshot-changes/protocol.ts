import { isArrayOf, isBoolean, isCount, isNullOr, isOneOf, isOptional, isShape, isString } from '../guards';
import type { Test } from '../guards';
import type { ChangeObject } from '../catalog/changes';
import type { ResolvedAction } from '../catalog/model';
import { isReportScope } from '../shell/scope';

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

/** A snapshot with its author, message and changes, as the reports of snapshots by time receive it. */
export const isSnapshot = isShape({
  id: isCount,
  time: isString,
  author: isNullOr(isString),
  commitMessage: isNullOr(isString),
  changes: isArrayOf(isChange),
});

/** The fields of a `SnapshotWindow`, for the guard of a page's data. */
export const WINDOW_FIELDS: Readonly<Record<string, Test>> = {
  connection: isString,
  latest: isCount,
  snapshots: isArrayOf(isSnapshot),
  more: isBoolean,
};

/** The fields of a `ScopedWindow`. */
export const SCOPED_WINDOW_FIELDS: Readonly<Record<string, Test>> = {
  ...WINDOW_FIELDS,
  scope: isReportScope,
  read: isOptional(isCount),
};
