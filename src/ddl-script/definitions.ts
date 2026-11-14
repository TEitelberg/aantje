import { alterViewDdl, createViewDdl, macroDdl } from '../catalog/ddl';
import type { MacroInfo, ViewInfo } from '../catalog/model';
import { allNeeding, fromCatalog, isStatement } from './check';
import type { CatalogCheck } from './check';
import { commentStatement } from './statements';

// The statements of a view and of a macro, which copy the SQL that the catalog stores: one builder for Script as,
// Script as Update, Generate Scripts and Restore Dropped Object. The catalog text goes through `check`.

export interface DefinitionOptions {
  /** `create` writes `CREATE VIEW` or `CREATE MACRO`, which fail when the name is taken; `replace` writes `CREATE OR REPLACE`. */
  readonly head: 'create' | 'replace';
  /**
   * What the note on a view or macro in another SQL dialect says: that running the statement replaces the one that is
   * there with a DuckDB one (`replaces`, the default), or that the SQL is copied as stored into one that is not there
   * (`copies`).
   */
  readonly note?: 'replaces' | 'copies';
  readonly check?: CatalogCheck;
}

const FOREIGN = {
  view: {
    replaces: '-- This view is stored in another SQL dialect; running this replaces it with a DuckDB view.',
    copies:
      '-- This view is stored in another SQL dialect. Its SQL is copied as stored, as in Copy DDL; DuckDB may read it differently or refuse it.',
  },
  macro: {
    replaces:
      '-- This macro is stored in another SQL dialect; running this replaces it with DuckDB overloads.',
    copies:
      '-- This macro is stored in another SQL dialect. Its SQL is copied as stored into DuckDB overloads; DuckDB may read it differently or refuse it.',
  },
} as const;

/** A macro statement with all its overloads under fixed notes: one for a macro in another dialect, and the `check` notes. */
export function macroScript(
  schemaName: string,
  macro: Pick<MacroInfo, 'name' | 'kind' | 'implementations'>,
  { head, note = 'replaces', check = fromCatalog }: DefinitionOptions,
): { notes: string[]; statement: string } {
  const made = check(
    macroDdl(schemaName, macro, head === 'create' ? 'CREATE MACRO' : 'CREATE OR REPLACE MACRO'),
    macro.implementations.flatMap(({ sql, parameters }) => [
      sql,
      ...parameters.flatMap(({ type, defaultValue }) => [type ?? '', defaultValue ?? '']),
    ]),
  );
  const foreign = macro.implementations.some(({ dialect }) => dialect !== 'duckdb');
  return { notes: [...(foreign ? [FOREIGN.macro[note]] : []), ...made.notes], statement: made.statement };
}

/** A view statement under fixed notes: one for a view in another dialect, and the `check` notes; the query is catalog text. */
export function viewScript(
  schemaName: string,
  view: Pick<ViewInfo, 'name' | 'sql' | 'dialect' | 'columnAliases'>,
  { head, note = 'replaces', check = fromCatalog }: DefinitionOptions,
): { notes: string[]; statement: string } {
  const foreign = view.dialect !== 'duckdb';
  const made = check(
    (head === 'create' ? createViewDdl : alterViewDdl)(schemaName, view),
    [view.sql],
    foreign,
  );
  return { notes: [...(foreign ? [FOREIGN.view[note]] : []), ...made.notes], statement: made.statement };
}

/** The lines of a macro: its notes and its statement. DuckLake keeps no comment of a macro. */
export function macroLines(
  schemaName: string,
  macro: Pick<MacroInfo, 'name' | 'kind' | 'implementations'>,
  options: DefinitionOptions,
): string[] {
  const { notes, statement } = macroScript(schemaName, macro, options);
  return [...notes, statement];
}

/** The lines of a view and its comment, which needs the view: when the view statement stays a comment, so does it. */
export function viewLines(
  schemaName: string,
  view: Pick<ViewInfo, 'name' | 'sql' | 'dialect' | 'columnAliases' | 'comment'>,
  options: DefinitionOptions,
): string[] {
  const { notes, statement } = viewScript(schemaName, view, options);
  const comment =
    view.comment === null ? [] : [commentStatement('VIEW', [schemaName, view.name], view.comment)];
  return [...notes, statement, ...(isStatement(statement) ? comment : allNeeding(comment))];
}
