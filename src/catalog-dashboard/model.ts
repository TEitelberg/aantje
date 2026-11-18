import type { CatalogDatabase, CatalogDatabaseTable, CatalogEngine } from '../catalog/model';
import { qualifiedName } from '../catalog/ddl';
import { INLINED_TABLE } from '../catalog/queries/maintenance';
import { count, formatBytes, formatUtc, percent, plural } from '../shell/model';
import type { Card, Severity } from '../shell/model';
import type { PagedColumn, PagedRow } from '../shell/paged-table';
import { reportHeading } from '../shell/report-heading';

/** The heading of the page, the panel and the document: the report is about the database of the whole catalog. */
export const DASHBOARD_HEADING = reportHeading('Catalog Dashboard');

/** The file of a SQLite or DuckDB catalog, as the file system of the extension host shows it when the report is read. */
export interface CatalogFile {
  /** Null when the file cannot be read. */
  readonly sizeBytes: number | null;
  /** The write-ahead log next to the file (`-wal` of SQLite, `.wal` of DuckDB); 0 when there is none. */
  readonly walBytes: number;
  /** SQLite: whether the file is in WAL mode (byte 18 of its header is 2); absent for DuckDB and when unreadable. */
  readonly walMode?: boolean;
}

/** What the extension sends to the page. */
export interface DashboardData {
  readonly connection: string;
  /** ISO 8601 UTC. */
  readonly readAt: string;
  readonly database: CatalogDatabase;
  /** SQLite and DuckDB. */
  readonly file?: CatalogFile;
  /** The DuckLake tables that inlined tables hold rows of, by id, named `schema.table` as at the newest snapshot. */
  readonly tableNames: readonly { readonly id: number; readonly name: string }[];
}

/** A PostgreSQL table with this many dead rows, and this share of its rows dead, waits for a vacuum. */
export const DEAD_ROWS = { min: 1000, share: 0.2 } as const;
/** A SQLite or DuckDB file with this share free could give the space back. */
export const FREE_SHARE = 0.25;

export const ENGINE_LABEL: Readonly<Record<CatalogEngine, string>> = {
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
  duckdb: 'DuckDB',
  quack: 'DuckDB over Quack',
};

/** What the dashboard points out; `vacuum` names the table that a VACUUM (ANALYZE) script is for. */
export interface DashboardFinding {
  readonly severity: Exclude<Severity, 'ok'> | 'info';
  readonly title: string;
  readonly detail: string;
  readonly vacuum?: string;
}

/** The share of a table's rows that are dead; 0 without rows. */
export function deadShare(table: CatalogDatabaseTable): number {
  const dead = table.deadRows ?? 0;
  const all = dead + (table.liveRows ?? 0);
  return all === 0 ? 0 : dead / all;
}

/** Whether a table waits for a vacuum: many dead rows, and a large share of its rows. */
export const needsVacuum = (table: CatalogDatabaseTable): boolean =>
  (table.deadRows ?? 0) >= DEAD_ROWS.min && deadShare(table) >= DEAD_ROWS.share;

/** The tables that a VACUUM (ANALYZE) script is offered for, largest first. */
export const vacuumTables = (data: DashboardData): CatalogDatabaseTable[] =>
  data.database.engine === 'postgres' ? data.database.tables.filter(needsVacuum) : [];

const lastOf = (...times: readonly (string | null | undefined)[]): string | null =>
  times
    .filter((time): time is string => typeof time === 'string')
    .toSorted()
    .at(-1) ?? null;

/** The latest vacuum of a table, by hand or by autovacuum; null for none. */
export const lastVacuum = (table: CatalogDatabaseTable): string | null =>
  lastOf(table.lastVacuum, table.lastAutovacuum);

/** The latest analyze of a table, by hand or by autovacuum; null for none. */
export const lastAnalyze = (table: CatalogDatabaseTable): string | null =>
  lastOf(table.lastAnalyze, table.lastAutoanalyze);

/** The inlined data tables with the rows they hold and the DuckLake table they belong to, most rows first. */
export function inlinedRows(
  data: DashboardData,
): { readonly name: string; readonly table: string; readonly rows: number | null }[] {
  const owner = new Map(data.database.inlined.map((entry) => [entry.name, entry.tableId]));
  const names = new Map(data.tableNames.map((entry) => [entry.id, entry.name]));
  return data.database.tables
    .filter((table) => INLINED_TABLE.test(table.name))
    .map((table) => {
      const id = owner.get(table.name);
      const name = id === undefined ? undefined : names.get(id);
      return {
        name: table.name,
        table: name ?? (id === undefined ? 'unknown table' : `table #${id} (dropped)`),
        rows: table.rows,
      };
    })
    .toSorted((a, b) => (b.rows ?? -1) - (a.rows ?? -1));
}

const countText = (value: number | null | undefined): string =>
  value === null || value === undefined ? '' : count(value);
const bytesText = (value: number | null | undefined): string =>
  value === null || value === undefined ? '' : formatBytes(value);

/** The columns of the table of catalog tables, as much as the engine tells; the first holds the buttons of the rows. */
export function tableColumns(database: CatalogDatabase): PagedColumn[] {
  const number = (label: string): PagedColumn => ({ label, className: 'number' });
  return database.engine === 'postgres'
    ? [
        { label: 'Table', className: 'name' },
        number('Rows (estimate)'),
        number('Size'),
        number('Indexes'),
        number('TOAST'),
        number('Inserted'),
        number('Deleted'),
        number('Dead rows'),
        { label: 'Last vacuum' },
        { label: 'Last analyze' },
      ]
    : [
        { label: 'Table', className: 'name' },
        number('Rows'),
        ...(database.sizesPerTable ? [number('Size')] : []),
      ];
}

/** The catalog tables as rows of the table, found by their names; one that waits for a vacuum has the warning sign. */
export function tableRows(database: CatalogDatabase): PagedRow<string>[] {
  const postgres = database.engine === 'postgres';
  return database.tables.map((table) => {
    const waits = postgres && needsVacuum(table);
    return {
      key: table.name,
      label: waits ? `${table.name} ⚠` : table.name,
      ...(waits ? { description: `${table.name}, with many dead rows` } : {}),
      cells: postgres
        ? [
            countText(table.rows),
            bytesText(table.totalBytes),
            bytesText(table.indexBytes),
            bytesText(table.toastBytes),
            countText(table.insertedRows),
            countText(table.deletedRows),
            countText(table.deadRows),
            timeText(lastVacuum(table)),
            timeText(lastAnalyze(table)),
          ]
        : [countText(table.rows), ...(database.sizesPerTable ? [bytesText(table.totalBytes)] : [])],
      search: '',
    };
  });
}

export const INLINED_COLUMNS: readonly PagedColumn[] = [
  { label: 'Inlined table', className: 'name' },
  { label: 'Rows of' },
  { label: 'Rows', className: 'number' },
];

/** The inlined data tables as rows of their table, found by their names and the table whose rows they hold. */
export const inlinedTableRows = (data: DashboardData): PagedRow<string>[] =>
  inlinedRows(data).map((entry) => ({
    key: entry.name,
    label: entry.name,
    cells: [entry.table, countText(entry.rows)],
    search: entry.table,
  }));

export function dashboardFindings(data: DashboardData): DashboardFinding[] {
  const { database, file } = data;
  const findings: DashboardFinding[] = vacuumTables(data).map((table) => ({
    severity: 'warning',
    title: `${table.name} has many dead rows`,
    detail: `${count(table.deadRows ?? 0)} dead rows, ${percent(deadShare(table))} of its rows. Every write and compaction of the lake ends rows of this table; until a vacuum removes them, they take space and slow down its reads. Last vacuum: ${timeText(lastVacuum(table))}.`,
    vacuum: table.name,
  }));
  const size = file?.sizeBytes ?? database.sizeBytes;
  if (database.freeBytes !== null && size !== null && size > 0 && database.freeBytes / size >= FREE_SHARE) {
    findings.push({
      severity: 'info',
      title: `${percent(database.freeBytes / size)} of the catalog file is free`,
      detail: `${formatBytes(database.freeBytes)} of ${formatBytes(size)} are free pages or blocks. The engine reuses them for new rows; the file shrinks only when it is rewritten while no writer has it open.`,
    });
  }
  return findings;
}

/** `not yet` for a time that never was. */
export const timeText = (time: string | null): string => (time === null ? 'never' : formatUtc(time));

const bytesOrUnknown = (bytes: number | null): string => (bytes === null ? 'not shown' : formatBytes(bytes));

function walText(engine: CatalogEngine, file: CatalogFile): string {
  if (engine === 'sqlite' && file.walMode === false) return 'rollback journal';
  const log = file.walBytes > 0 ? `${formatBytes(file.walBytes)} not checkpointed` : 'empty';
  return engine === 'sqlite' && file.walMode === true ? `WAL mode, log ${log}` : `log ${log}`;
}

function largestCard(largest: CatalogDatabaseTable | undefined): Card {
  if (!largest) return { label: 'Largest table', value: 'none', severity: 'ok' };
  const rows = largest.rows === null ? '?' : count(largest.rows);
  const size = largest.totalBytes === null ? `${rows} rows` : formatBytes(largest.totalBytes);
  return { label: 'Largest table', value: largest.name, detail: size, severity: 'ok' };
}

// Dead rows and SSL: what only PostgreSQL tells.
function postgresCards(data: DashboardData): Card[] {
  const { database } = data;
  const { ssl } = database;
  const dead = database.tables.reduce((sum, table) => sum + (table.deadRows ?? 0), 0);
  return [
    { label: 'Dead rows', value: count(dead), severity: vacuumTables(data).length > 0 ? 'warning' : 'ok' },
    { label: 'SSL', value: ssl === true ? 'yes' : ssl === false ? 'no' : 'not shown', severity: 'ok' },
  ];
}

/** The key figures of the page and the facts of the document. */
export function dashboardCards(data: DashboardData): Card[] {
  const { database, file } = data;
  const catalogBytes = database.tables.reduce((sum, table) => sum + (table.totalBytes ?? 0), 0);
  const inlined = inlinedRows(data);
  return [
    {
      label: database.engine === 'postgres' ? 'Database' : 'File',
      value: bytesOrUnknown(file?.sizeBytes ?? database.sizeBytes),
      ...(database.version === null
        ? {}
        : { detail: `${ENGINE_LABEL[database.engine]} ${database.version}` }),
      severity: 'ok',
    },
    {
      label: 'Catalog tables',
      value: count(database.tables.length),
      ...(database.sizesPerTable ? { detail: formatBytes(catalogBytes) } : {}),
      severity: 'ok',
    },
    largestCard(database.tables[0]),
    {
      label: 'Inlined data',
      value: plural(inlined.length, 'table', 'tables'),
      detail: `${count(inlined.reduce((sum, entry) => sum + (entry.rows ?? 0), 0))} rows in the catalog`,
      severity: 'ok',
    },
    ...(database.engine === 'postgres' ? postgresCards(data) : []),
    ...(database.freeBytes === null
      ? []
      : [{ label: 'Free in the file', value: formatBytes(database.freeBytes), severity: 'ok' } as const]),
    ...(file
      ? [{ label: 'Write-ahead log', value: walText(database.engine, file), severity: 'ok' } as const]
      : []),
  ];
}

/** The notes of the page and the document: what the engine does not tell, and what was not read. */
export function dashboardNotes(data: DashboardData): string[] {
  const { engine } = data.database;
  return [
    ...(engine === 'quack'
      ? [
          'A Quack server answers queries on its tables but tells nothing about its database file: the rows of the catalog tables are counted, and size and free space are not shown. Ask on the server: PRAGMA database_size;',
        ]
      : []),
    ...(engine === 'sqlite'
      ? [
          'aantje reads a copy of the SQLite file taken at connect: the pages and rows are those of the copy, the file and its log are read now. Refresh the connection to read a newer copy.',
        ]
      : []),
    ...(engine !== 'postgres' && !data.database.sizesPerTable
      ? [
          `${ENGINE_LABEL[engine]} does not tell the size of each table, so the tables are listed by their rows.`,
        ]
      : []),
    ...data.database.unread.map((line) => `Not read: ${line}`),
  ];
}

/** The script that a finding opens: VACUUM (ANALYZE) of the tables, for a PostgreSQL client; it runs nothing itself. */
export function vacuumScript(schema: string, tables: readonly string[]): string {
  return [
    '-- VACUUM (ANALYZE) of catalog tables with many dead rows. Nothing ran when this document opened.',
    '-- VACUUM runs in PostgreSQL, not in DuckDB: run it with psql or another PostgreSQL client connected to the catalog',
    '-- database, as a user that may vacuum these tables (their owner, or a member of pg_maintain from PostgreSQL 17).',
    '-- The SQL editor of aantje runs DuckDB and cannot run it. VACUUM cannot run inside a transaction block.',
    '',
    ...tables.map((table) => `VACUUM (ANALYZE) ${qualifiedName(schema, table)};`),
    '',
  ].join('\n');
}
