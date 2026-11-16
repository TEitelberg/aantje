import type { IcebergCheck } from '../iceberg/read';
import type { IcebergCopyRecord } from '../iceberg/records';
import { PROBLEM_TEXT } from '../iceberg/status';
import type { TableProblem } from '../iceberg/status';
import type { IcebergTarget } from '../iceberg/target';
import { count } from '../shell/model';
import type { Card } from '../shell/model';

/** The actions of the page that the extension may offer. */
export const ICEBERG_ACTIONS = ['copyAgain', 'forget'] as const;
export type IcebergActionId = (typeof ICEBERG_ACTIONS)[number];

export interface IcebergTableRow {
  readonly schema: string;
  readonly table: string;
  /** Empty: the table is in sync. */
  readonly problems: readonly TableProblem[];
  readonly copiedSnapshot: number;
  readonly snapshotsBehind: number;
  readonly lakeChangedAt: string | null;
  readonly icebergRemembered: string | null;
  readonly icebergCurrent: string | null;
  readonly rows: number | null;
  /** Columns written as another type. */
  readonly converted: readonly string[];
  /** Why the table could not be checked. */
  readonly checkError: string | null;
  /** `namespace.table` of the Iceberg table when the copy wrote it elsewhere than the schema and table of the lake. */
  readonly iceberg?: string;
}

/** What the extension sends to the page. */
export interface IcebergData {
  readonly connection: string;
  readonly target: {
    readonly id: string;
    readonly name: string;
    readonly warehouse: string;
    readonly endpoint: string;
  };
  readonly inSync: boolean;
  readonly newest: number;
  readonly checkedAt: string;
  readonly copiedAt: string;
  readonly icebergError: string | null;
  readonly tables: readonly IcebergTableRow[];
  /** Tables of the lake that the copy does not have. */
  readonly added: readonly { readonly schema: string; readonly table: string }[];
  readonly actions: readonly IcebergActionId[];
}

/** The text of a table's state: `In sync`, or its problems. */
export const stateText = (problems: readonly TableProblem[]): string =>
  problems.length === 0 ? 'In sync' : problems.map((problem) => PROBLEM_TEXT[problem]).join(', ');

export const tableName = (row: Pick<IcebergTableRow, 'schema' | 'table' | 'iceberg'>): string =>
  `${row.schema}.${row.table}${row.iceberg === undefined ? '' : ` → ${row.iceberg}`}`;

/** The rows with the text in their name or state, ignoring case; all for an empty filter. */
export function matchingRows(rows: readonly IcebergTableRow[], filter: string): IcebergTableRow[] {
  const wanted = filter.trim().toLowerCase();
  return rows.filter(
    (row) => wanted === '' || `${tableName(row)} ${stateText(row.problems)}`.toLowerCase().includes(wanted),
  );
}

export function buildIcebergData(input: {
  readonly connection: string;
  readonly target: IcebergTarget;
  readonly records: readonly IcebergCopyRecord[];
  readonly check: IcebergCheck;
  readonly actions: readonly IcebergActionId[];
}): IcebergData {
  const { check, records, target } = input;
  const byName = new Map(records.map((record) => [`${record.schema}.${record.table}`, record]));
  return {
    connection: input.connection,
    target: { id: target.id, name: target.name, warehouse: target.warehouse, endpoint: target.endpoint },
    inSync: check.status.inSync,
    newest: check.newest,
    checkedAt: check.checkedAt,
    copiedAt:
      records
        .map((record) => record.copiedAt)
        .toSorted()
        .at(-1) ?? '',
    icebergError: check.icebergError ?? null,
    tables: check.status.tables.map((status): IcebergTableRow => {
      const record = byName.get(`${status.schema}.${status.table}`);
      return {
        schema: status.schema,
        table: status.table,
        problems: status.problems,
        copiedSnapshot: status.copiedSnapshot,
        snapshotsBehind: status.snapshotsBehind,
        lakeChangedAt: status.lakeChangedAt ?? null,
        icebergRemembered: status.icebergRemembered ?? null,
        icebergCurrent: status.icebergCurrent ?? null,
        rows: record?.rows ?? null,
        converted: record?.converted ?? [],
        checkError: status.checkError ?? null,
        ...(status.iceberg === undefined ? {} : { iceberg: status.iceberg }),
      };
    }),
    added: check.status.added,
    actions: input.actions,
  };
}

/** The cards of the page and the summary of the document. */
export function icebergCards(data: IcebergData): Card[] {
  const out = data.tables.filter((row) => row.problems.length > 0).length;
  const copiedSnapshots = [...new Set(data.tables.map((row) => row.copiedSnapshot))].toSorted(
    (a, b) => a - b,
  );
  return [
    { label: 'Tables synced', value: count(data.tables.length), severity: 'ok' },
    {
      label: 'In sync',
      value: count(data.tables.length - out),
      severity: out === 0 ? 'ok' : 'error',
    },
    { label: 'Out of sync', value: count(out), severity: out === 0 ? 'ok' : 'error' },
    {
      label: 'New in the lake',
      value: count(data.added.length),
      severity: data.added.length === 0 ? 'ok' : 'error',
    },
    {
      label: 'Synced at',
      value: copiedSnapshots.length === 0 ? 'none' : `@${copiedSnapshots[0]}`,
      detail: `the lake is at @${data.newest}`,
      severity: 'ok',
    },
  ];
}

/** The Iceberg report of a copy, as the commands that offer it use it. */
export interface IcebergReport {
  show(connectionId: string, targetId: string): Promise<void>;
  /** Reads the report of a copy again if it is open, after the copy; a closed report stays closed. */
  refresh(connectionId: string, targetId: string): void;
  dispose(): void;
}
