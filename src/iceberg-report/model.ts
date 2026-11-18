import type { IcebergCheck } from '../iceberg/read';
import type { IcebergCopyRecord, IcebergFailureRecord } from '../iceberg/records';
import { PROBLEM_TEXT } from '../iceberg/status';
import type { TableProblem } from '../iceberg/status';
import { targetPlace } from '../iceberg/target';
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
  /** Why the last sync could not write the table: the row of a table that has no copy, its other fields empty. */
  readonly failed?: string;
}

/** What the extension sends to the page. */
export interface IcebergData {
  readonly connection: string;
  readonly target: {
    readonly id: string;
    readonly name: string;
    readonly warehouse: string;
    readonly endpoint: string;
    /** Where the target is, in words: the Fabric lakehouse and its workspace, or the warehouse at the endpoint. */
    readonly place: string;
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

/** The text of the state of a row: `Error` for a table that the last sync could not write. */
export const rowState = (row: Pick<IcebergTableRow, 'problems' | 'failed'>): string =>
  row.failed === undefined ? stateText(row.problems) : 'Error';

/** The rows with the text in their name or state, ignoring case; all for an empty filter. */
export function matchingRows(rows: readonly IcebergTableRow[], filter: string): IcebergTableRow[] {
  const wanted = filter.trim().toLowerCase();
  return rows.filter(
    (row) => wanted === '' || `${tableName(row)} ${rowState(row)}`.toLowerCase().includes(wanted),
  );
}

export function buildIcebergData(input: {
  readonly connection: string;
  readonly target: IcebergTarget;
  readonly records: readonly IcebergCopyRecord[];
  readonly check: IcebergCheck;
  readonly actions: readonly IcebergActionId[];
  /** The tables that syncs to the target could not write: those still in the lake are rows of the state Error. */
  readonly failures?: readonly IcebergFailureRecord[];
}): IcebergData {
  const { check, records, target } = input;
  const byName = new Map(records.map((record) => [`${record.schema}.${record.table}`, record]));
  const failedOf = new Map(
    (input.failures ?? []).map((failure) => [`${failure.schema}.${failure.table}`, failure]),
  );
  const failedRows = check.status.added.flatMap((table): IcebergTableRow[] => {
    const failure = failedOf.get(`${table.schema}.${table.table}`);
    return failure === undefined
      ? []
      : [
          {
            schema: table.schema,
            table: table.table,
            problems: [],
            copiedSnapshot: failure.snapshot,
            snapshotsBehind: 0,
            lakeChangedAt: null,
            icebergRemembered: null,
            icebergCurrent: null,
            rows: null,
            converted: [],
            checkError: null,
            failed: failure.error,
          },
        ];
  });
  return {
    connection: input.connection,
    target: {
      id: target.id,
      name: target.name,
      warehouse: target.warehouse,
      endpoint: target.endpoint,
      place: targetPlace(target),
    },
    inSync: check.status.inSync,
    newest: check.newest,
    checkedAt: check.checkedAt,
    copiedAt:
      records
        .map((record) => record.copiedAt)
        .toSorted()
        .at(-1) ?? '',
    icebergError: check.icebergError ?? null,
    tables: [
      ...check.status.tables.map((status): IcebergTableRow => {
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
      ...failedRows,
    ].toSorted((a, b) => tableName(a).localeCompare(tableName(b))),
    added: check.status.added.filter((table) => !failedOf.has(`${table.schema}.${table.table}`)),
    actions: input.actions,
  };
}

/** The cards of the page and the summary of the document. */
export function icebergCards(data: IcebergData): Card[] {
  // A table the last sync could not write has no copy: it counts as out of sync, not as synced.
  const copied = data.tables.filter((row) => row.failed === undefined);
  const out = data.tables.filter((row) => row.problems.length > 0 || row.failed !== undefined).length;
  const copiedSnapshots = [...new Set(copied.map((row) => row.copiedSnapshot))].toSorted((a, b) => a - b);
  return [
    { label: 'Tables synced', value: count(copied.length), severity: 'ok' },
    {
      label: 'In sync',
      value: count(copied.length - copied.filter((row) => row.problems.length > 0).length),
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
