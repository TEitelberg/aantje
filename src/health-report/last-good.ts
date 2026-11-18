// The panel of Find Last Good Snapshot: the snapshot found, the first bad one after it and what was found there, and
// the actions that go back to it. Pure: the run is `health/last-good.ts`, the page `last-good-page.ts`.
import {
  isArrayOf,
  isBoolean,
  isCount,
  isNullOr,
  isObject,
  isOneOf,
  isShape,
  isString,
  isTrue,
  own,
} from '../guards';
import { CONSISTENCY_CHECKS } from '../catalog/model';
import type { FindingScope } from '../health/model';
import type { LastGoodResult, SnapshotRef } from '../health/last-good';
import { capRows, code, markdownTable, markdownText, visibleLine } from '../markdown';
import { count, formatUtc, whoText } from '../shell/model';
import { actionGuard } from '../shell/protocol';
import type { ActionMessage } from '../shell/protocol';
import type { ReportKind } from '../shell/panels';
import { SHELL_CSS } from '../shell/style';
import { healthScopeLabel, lastGoodHeading } from './model';

/** A table that changed after the good snapshot: Query at Snapshot and Restore Table to Snapshot bring back its rows. */
export interface ChangedTable {
  readonly id: number;
  readonly schemaId: number;
  readonly schema: string;
  readonly name: string;
  /** The snapshot of its last change. */
  readonly lastChange: number;
}

/** What the extension sends to the page. */
export interface LastGoodData {
  readonly connection: string;
  readonly scope: FindingScope;
  readonly result: LastGoodResult;
  readonly tables: readonly ChangedTable[];
}

export const snapshotText = (snapshot: SnapshotRef): string => {
  const who = whoText(snapshot.author, snapshot.commitMessage);
  return `@${snapshot.id} · ${formatUtc(snapshot.time)}${who === '' ? '' : ` · ${who}`}`;
};

/** The answer in one sentence. */
export function verdictText({ result }: LastGoodData): string {
  if (result.cancelled) return `Cancelled after ${count(result.checked)} snapshots.`;
  if (result.good === null) {
    return `None of the ${count(result.checked)} newest snapshots passes the checks${result.more ? '; older ones were not looked at' : ''}.`;
  }
  return result.good.id === result.newest
    ? `The newest snapshot @${result.newest} passes the checks.`
    : `@${result.good.id} is the newest snapshot at which the checks pass; ${count(result.checked - 1)} newer ${result.checked === 2 ? 'snapshot does' : 'snapshots do'} not.`;
}

/** What makes the first bad snapshot bad, one line each. */
export function badLines({ result }: LastGoodData): string[] {
  const bad = result.firstBad;
  if (!bad) return [];
  return [
    ...(bad.fileCount > 0
      ? [`It needs ${count(bad.fileCount)} files that the store lacks or holds with another size.`]
      : []),
    ...bad.problems.map(({ check, count: rows }) => `${count(rows)} rows break the catalog check ${check}.`),
  ];
}

export const filesNote = ({ result }: LastGoodData): string =>
  result.files.checked
    ? `The store was compared once: ${count(result.files.bad)} files of the scope are missing or have another size, and every snapshot that needs one is bad.`
    : `The store was not compared (${result.files.reason}), so only the catalog rows were checked.`;

export const RESTORE_NOTE =
  'Nothing was changed. A table restored to the snapshot gets back its rows of then; problems of the catalog itself are repaired by restoring the catalog from a backup, not by editing its tables.';

const TABLE_ROWS = 100;

/** The Markdown of the panel. */
export function lastGoodMarkdown(data: LastGoodData): string {
  const { result } = data;
  const bad = result.firstBad;
  const { shown, omitted } = capRows(data.tables, TABLE_ROWS);
  return [
    `# ${markdownText(visibleLine(`${lastGoodHeading(data.scope)} · ${data.connection}`))}`,
    '',
    `Scope: ${markdownText(healthScopeLabel(data.scope))}. ${count(result.checked)} of at most ${count(result.limit)} snapshots looked at, newest @${result.newest}.`,
    '',
    markdownText(verdictText(data)),
    '',
    ...(result.good ? [`Good: ${code(snapshotText(result.good))}`, ''] : []),
    ...(bad
      ? [
          `First bad snapshot after it: ${code(snapshotText(bad.snapshot))}`,
          '',
          ...badLines(data).map((line) => `- ${markdownText(line)}`),
          ...bad.files.map(
            (file) =>
              `- ${file.problem === 'missing' ? 'Missing' : 'Other size'}: ${file.kind} file #${file.id}${file.table === null ? '' : ` of ${code(file.table)}`} ${code(file.location ?? '')}`,
          ),
          '',
        ]
      : []),
    markdownText(filesNote(data)),
    '',
    ...(data.tables.length === 0
      ? []
      : [
          '## Tables that changed after the good snapshot',
          '',
          ...markdownTable(
            ['Table', 'Last change'],
            shown.map((table) => [code(`${table.schema}.${table.name}`), `@${table.lastChange}`]),
          ),
          ...omitted,
          '',
        ]),
    markdownText(RESTORE_NOTE),
    '',
  ].join('\n');
}

const isRef = isShape({
  id: isCount,
  time: isString,
  author: isNullOr(isString),
  commitMessage: isNullOr(isString),
});

const isData = isShape({
  connection: isString,
  scope: isShape({ kind: isOneOf('lake', 'schema', 'table') }),
  result: isShape({
    newest: isCount,
    good: isNullOr(isRef),
    firstBad: isNullOr(
      isShape({
        snapshot: isRef,
        files: isArrayOf(
          isShape({
            kind: isOneOf('data', 'delete'),
            id: isCount,
            location: isNullOr(isString),
            table: isNullOr(isString),
            problem: isOneOf('missing', 'size'),
          }),
        ),
        fileCount: isCount,
        problems: isArrayOf(isShape({ check: isOneOf(...CONSISTENCY_CHECKS), count: isCount })),
      }),
    ),
    checked: isCount,
    limit: isCount,
    more: isBoolean,
    files: (value: unknown) =>
      isShape({ checked: isTrue, bad: isCount })(value) ||
      isShape({ checked: isOneOf(false), reason: isString })(value),
    cancelled: isBoolean,
  }),
  tables: isArrayOf(
    isShape({ id: isCount, schemaId: isCount, schema: isString, name: isString, lastChange: isCount }),
  ),
});

/** Guard for the messages the extension sends to the page. */
export function isLastGoodMessage(
  value: unknown,
): value is { readonly type: 'lastGood'; readonly data: LastGoodData } {
  return isObject(value) && own(value, 'type') === 'lastGood' && isData(own(value, 'data'));
}

export type LastGoodAction = ActionMessage & {
  readonly action: 'showCatalog' | 'lookFurther' | 'queryAtSnapshot' | 'restoreTable';
  /** The id of a table that changed after the good snapshot. */
  readonly table?: number;
};

/** The page names an action and a table id; the extension checks both against its data. */
export const isLastGoodAction: (value: unknown) => value is LastGoodAction = actionGuard({
  showCatalog: {},
  lookFurther: {},
  queryAtSnapshot: { table: isCount },
  restoreTable: { table: isCount },
});

export type LastGoodPlan =
  | { readonly action: 'showCatalog'; readonly snapshot: number }
  | { readonly action: 'lookFurther'; readonly limit: number }
  | { readonly action: 'queryAtSnapshot' | 'restoreTable'; readonly table: ChangedTable };

/** The plan of a request: only what the data offers (a good snapshot, a limit that was reached, a table it lists). */
export function planLastGoodAction(data: LastGoodData, message: LastGoodAction): LastGoodPlan | undefined {
  const { result } = data;
  switch (message.action) {
    case 'showCatalog':
      return result.good ? { action: 'showCatalog', snapshot: result.good.id } : undefined;
    case 'lookFurther':
      return result.good === null && result.more
        ? { action: 'lookFurther', limit: result.limit * 2 }
        : undefined;
    default: {
      const table = data.tables.find((candidate) => candidate.id === message.table);
      return table && result.good ? { action: message.action, table } : undefined;
    }
  }
}

export const LAST_GOOD_CSS = `${SHELL_CSS}
.verdict { font-weight: 600; }
td.name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
.files li { font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
`;

export const lastGoodKind: ReportKind<LastGoodData, LastGoodAction, never> = {
  viewType: 'aantje.lastGoodSnapshot',
  css: LAST_GOOD_CSS,
  message: (data) => ({ type: 'lastGood', data }),
  isAction: isLastGoodAction,
  toMarkdown: (data) => lastGoodMarkdown(data),
};
