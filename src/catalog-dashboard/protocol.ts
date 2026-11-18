import {
  isArrayOf,
  isBoolean,
  isCount,
  isNullOr,
  isObject,
  isOneOf,
  isOptional,
  isShape,
  isString,
  own,
} from '../guards';
import { actionGuard } from '../shell/protocol';
import type { ActionMessage } from '../shell/protocol';
import type { DashboardData } from './model';

type DashboardMessage = { readonly type: 'catalogDashboard'; readonly data: DashboardData };

const isTime = isOptional(isNullOr(isString));

const isTable = isShape({
  name: isString,
  rows: isNullOr(isCount),
  totalBytes: isNullOr(isCount),
  tableBytes: isOptional(isCount),
  indexBytes: isOptional(isCount),
  toastBytes: isOptional(isCount),
  deadRows: isOptional(isCount),
  liveRows: isOptional(isCount),
  insertedRows: isOptional(isCount),
  deletedRows: isOptional(isCount),
  lastVacuum: isTime,
  lastAutovacuum: isTime,
  lastAnalyze: isTime,
  lastAutoanalyze: isTime,
});

const isData = isShape({
  connection: isString,
  readAt: isString,
  database: isShape({
    engine: isOneOf('postgres', 'sqlite', 'duckdb', 'quack'),
    version: isNullOr(isString),
    schema: isOptional(isString),
    sizeBytes: isNullOr(isCount),
    freeBytes: isNullOr(isCount),
    ssl: isOptional(isNullOr(isBoolean)),
    sizesPerTable: isBoolean,
    tables: isArrayOf(isTable),
    inlined: isArrayOf(isShape({ name: isString, tableId: isCount })),
    unread: isArrayOf(isString),
  }),
  file: isOptional(
    isShape({ sizeBytes: isNullOr(isCount), walBytes: isCount, walMode: isOptional(isBoolean) }),
  ),
  tableNames: isArrayOf(isShape({ id: isCount, name: isString })),
});

/** Guard for the messages the extension sends to the page. */
export function isDashboardMessage(value: unknown): value is DashboardMessage {
  return isObject(value) && own(value, 'type') === 'catalogDashboard' && isData(own(value, 'data'));
}

export type DashboardActionId = 'vacuumScript' | 'vacuumAll';

export type DashboardAction = ActionMessage & {
  readonly action: DashboardActionId;
  /** The index of the table in `database.tables`. */
  readonly table?: number;
};

/** A known action with exactly its fields; `planDashboardAction` checks that the table is one that needs a vacuum. */
export const isDashboardAction: (value: unknown) => value is DashboardAction = actionGuard({
  vacuumScript: { table: isCount },
  vacuumAll: {},
});
