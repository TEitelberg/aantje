import { createTableDdl } from '../catalog/ddl';
import { allNeeding, columnFragments, isStatement } from './check';
import type { CatalogCheck } from './check';
import type { TableState } from './table-state';
import { stepLines, tableSteps } from './table-update';
import type { Step } from './table-update';

// A table as a script creates it: the CREATE TABLE of Script as CREATE with the options of the table, then its
// partitioning, sort order and comments, which DuckLake has no CREATE TABLE clause for. Script as CREATE writes those
// as comments; Generate Scripts, Script as Update of a new table and Restore Dropped Object write them live.

export interface CreatedTable {
  readonly state: TableState;
  /** The options of the table for the `WITH` clause, as Script as CREATE writes them. */
  readonly options: readonly { readonly name: string; readonly value: string }[];
}

export interface TableDdl {
  /** The notes of the check above the CREATE TABLE. */
  readonly notes: readonly string[];
  /** The CREATE TABLE; a comment when the check comments it out. */
  readonly create: string;
  /** True when the CREATE TABLE stays a statement. */
  readonly live: boolean;
  /** The partitioning, the sort order and the comments: what Script as Update of the table without them writes. */
  readonly followUps: readonly Step[];
}

/** The DDL of a new table in the schema; the statements that copy catalog text go through `check`. */
export function tableDdl(
  schemaName: string,
  { state, options }: CreatedTable,
  check: CatalogCheck,
): TableDdl {
  const created = check(
    createTableDdl(schemaName, state.name, state.columns, options),
    columnFragments(state.columns),
  );
  const bare: TableState = {
    ...state,
    schemaName,
    comment: null,
    partitioning: undefined,
    sortOrder: undefined,
    columns: state.columns.map((column) => ({ ...column, comment: null })),
  };
  return {
    notes: created.notes,
    create: created.statement,
    live: isStatement(created.statement),
    followUps: tableSteps(state, bare, check),
  };
}

/** The lines of the DDL with live follow-ups. They need the table: when its CREATE TABLE stays a comment, so do they. */
export function createLines({ notes, create, live, followUps }: TableDdl): string[] {
  const rest = stepLines(followUps);
  return [...notes, create, ...(live ? rest : allNeeding(rest))];
}
