import {
  isBoolean,
  isArrayOf,
  isCount,
  isExactShape,
  isNullOr,
  isObject,
  isOneOf,
  isShape,
  isString,
  own,
} from '../guards';
import { actionGuard } from '../shell/protocol';
import type { ActionMessage } from '../shell/protocol';
import { PROPERTIES_ACTIONS } from './model';
import type { PropertiesActionId, PropertiesData, PropertiesView } from './model';

type PropertiesMessage = { readonly type: 'properties'; readonly data: PropertiesData };

const isEntry = isShape({
  key: isString,
  value: isString,
  scope: isNullOr(isString),
  scopeId: isNullOr(isCount),
});

const isData = isShape({
  connection: isString,
  properties: isShape({
    specVersion: isString,
    createdBy: isNullOr(isString),
    dataPath: isNullOr(isString),
    encrypted: isBoolean,
    metadata: isArrayOf(isEntry),
    snapshotCount: isCount,
    firstSnapshotTime: isNullOr(isString),
    latestSnapshotTime: isNullOr(isString),
  }),
  actions: isArrayOf(isOneOf(...PROPERTIES_ACTIONS)),
});

/** Guard for the messages the extension sends to the page. */
export function isPropertiesMessage(value: unknown): value is PropertiesMessage {
  return isObject(value) && own(value, 'type') === 'properties' && isData(own(value, 'data'));
}

export type PropertiesAction = ActionMessage & { readonly action: PropertiesActionId };

/** A known action with no field; the extension checks that it was offered. */
export const isPropertiesAction: (value: unknown) => value is PropertiesAction = actionGuard({
  showStorage: {},
});

export const isPropertiesView: (value: unknown) => value is PropertiesView = isExactShape({
  filter: isString,
}) as (value: unknown) => value is PropertiesView;
