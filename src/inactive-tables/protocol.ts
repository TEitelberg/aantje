import {
  isArrayOf,
  isCount,
  isNullOr,
  isObject,
  isOptional,
  isShape,
  isString,
  isTrue,
  own,
} from '../guards';
import { actionGuard } from '../shell/protocol';
import type { ActionMessage } from '../shell/protocol';
import { isReportScope } from '../shell/scope';
import type { InactiveData } from './model';

type InactiveMessage = { readonly type: 'inactiveTables'; readonly data: InactiveData };

const isTable = isShape({
  id: isCount,
  schemaId: isCount,
  schema: isString,
  name: isString,
  comment: isNullOr(isString),
  rows: isCount,
  approximate: isOptional(isTrue),
  sizeBytes: isCount,
  files: isCount,
  change: isNullOr(
    isShape({
      snapshot: isCount,
      time: isNullOr(isString),
      before: isNullOr(isString),
      author: isNullOr(isString),
      commitMessage: isNullOr(isString),
    }),
  ),
  lastRead: isNullOr(isString),
});

const isData = isShape({
  connection: isString,
  scope: isReportScope,
  readAt: isString,
  snapshot: isCount,
  days: isCount,
  tables: isArrayOf(isTable),
  tableCount: isCount,
});

/** Guard for the messages the extension sends to the page. */
export function isInactiveMessage(value: unknown): value is InactiveMessage {
  return isObject(value) && own(value, 'type') === 'inactiveTables' && isData(own(value, 'data'));
}

/** The actions on a table of the report; each does what the command of that name does on the table. */
export type TableActionId = 'revealTable' | 'showStatistics' | 'showDependencies';

export type InactiveAction = ActionMessage & {
  readonly action: TableActionId | 'days';
  /** The id of a table the page was sent. */
  readonly table?: number;
  /** The days without a change to read the tables for. */
  readonly days?: number;
};

/** A known action with exactly its fields; `planInactiveAction` checks the table and the days against the data. */
export const isInactiveAction: (value: unknown) => value is InactiveAction = actionGuard({
  revealTable: { table: isCount },
  showStatistics: { table: isCount },
  showDependencies: { table: isCount },
  days: { days: isCount },
});
