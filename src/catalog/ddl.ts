import type { ColumnInfo, MacroInfo, MacroParameter, ViewInfo } from './model';

// DuckLake type names (spec 1.1) to DuckDB types. Spelled out because DuckDB reads some differently:
// its alias `int8` is a BIGINT, DuckLake's `int8` is 8 bits wide.
const LEAF_TYPES: ReadonlyMap<string, string> = new Map([
  ['boolean', 'BOOLEAN'],
  ['null', '"NULL"'],
  ['int8', 'TINYINT'],
  ['int16', 'SMALLINT'],
  ['int32', 'INTEGER'],
  ['int64', 'BIGINT'],
  ['int128', 'HUGEINT'],
  ['uint8', 'UTINYINT'],
  ['uint16', 'USMALLINT'],
  ['uint32', 'UINTEGER'],
  ['uint64', 'UBIGINT'],
  ['uint128', 'UHUGEINT'],
  ['float32', 'FLOAT'],
  ['float64', 'DOUBLE'],
  ['time', 'TIME'],
  ['time_ns', 'TIME_NS'],
  ['timetz', 'TIME WITH TIME ZONE'],
  ['date', 'DATE'],
  ['timestamp', 'TIMESTAMP'],
  ['timestamptz', 'TIMESTAMP WITH TIME ZONE'],
  ['timestamptz_ns', 'TIMESTAMPTZ_NS'],
  ['timestamp_s', 'TIMESTAMP_S'],
  ['timestamp_ms', 'TIMESTAMP_MS'],
  ['timestamp_ns', 'TIMESTAMP_NS'],
  ['interval', 'INTERVAL'],
  ['varchar', 'VARCHAR'],
  ['blob', 'BLOB'],
  ['json', 'JSON'],
  ['uuid', 'UUID'],
  ['variant', 'VARIANT'],
  ['geometry', 'GEOMETRY'],
]);

/** Double-quotes an identifier, doubling embedded quotes. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * An identifier as DuckDB compares it: A to Z match in either case, every other letter only itself, so `"Ä"` and `"ä"`
 * are two names. Every comparison of catalog names goes through it.
 */
export const foldIdentifier = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** Whether two identifiers name the same object for DuckDB; see `foldIdentifier`. */
export const sameIdentifier = (a: string, b: string): boolean => foldIdentifier(a) === foldIdentifier(b);

/** A string literal, doubling embedded single quotes. */
export function quoteLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** Quoted parts joined by dots, e.g. `"sales"."orders"`. */
export function qualifiedName(...parts: string[]): string {
  return parts.map(quoteIdentifier).join('.');
}

/** `CREATE TABLE` in DuckDB syntax; defaults are copied as SQL, unknown types pass through. The options are literals for a `WITH` clause. */
export function createTableDdl(
  schemaName: string,
  tableName: string,
  columns: readonly ColumnInfo[],
  options: readonly { readonly name: string; readonly value: string }[] = [],
): string {
  return createTableNamed([schemaName, tableName], columns, options);
}

/** `createTableDdl` with the name in other parts: one part names the table without its schema. */
export function createTableNamed(
  name: readonly string[],
  columns: readonly ColumnInfo[],
  options: readonly { readonly name: string; readonly value: string }[] = [],
): string {
  const definitions = columns.map((column) => `  ${columnDefinition(column)}`);
  const clause =
    options.length === 0
      ? ''
      : ` WITH (${options.map((option) => `${option.name} = ${option.value}`).join(', ')})`;
  return `CREATE TABLE ${qualifiedName(...name)} (\n${definitions.join(',\n')}\n)${clause};`;
}

// DuckLake accepts only NULL, a boolean, a number or a string as the default of an added column.
const LITERAL_DEFAULT = /^(?:NULL|TRUE|FALSE|[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?|'(?:[^']|'')*')$/i;

/**
 * Statements that add a column, plus notes on DuckLake's handling: a struct field gets its type only, an expression
 * default applies to new rows only, `NOT NULL` needs a default or an empty table.
 */
export function addColumnDdl(
  schemaName: string,
  tableName: string,
  path: readonly string[],
  column: ColumnInfo,
): { statements: string[]; notes: string[] } {
  const table = qualifiedName(schemaName, tableName);
  const add = (definition: string): string => `ALTER TABLE ${table} ADD COLUMN ${definition};`;
  if (path.length > 1) {
    return { statements: [add(`${path.map(quoteIdentifier).join('.')} ${sqlType(column)}`)], notes: [] };
  }
  const { defaultValue, nullable } = column;
  if (defaultValue !== null && !LITERAL_DEFAULT.test(defaultValue)) {
    return {
      statements: [
        add(columnDefinition({ ...column, defaultValue: null, nullable: true })),
        `ALTER TABLE ${table} ALTER COLUMN ${quoteIdentifier(column.name)} SET DEFAULT ${defaultValue};`,
      ],
      notes: [
        '-- DuckLake adds a column with a literal default only: the default is set after the column is added and applies to new rows.',
        ...(nullable ? [] : ['-- NOT NULL is left out: the rows that exist have no value for the column.']),
      ],
    };
  }
  return {
    statements: [add(columnDefinition(column))],
    notes:
      defaultValue === null && !nullable
        ? ['-- DuckLake adds a NOT NULL column without a default only to a table without rows.']
        : [],
  };
}

export function createViewDdl(
  schemaName: string,
  view: Pick<ViewInfo, 'name' | 'sql' | 'columnAliases'>,
): string {
  return viewStatement('CREATE VIEW', schemaName, view);
}

/** `CREATE OR REPLACE VIEW`, because DuckDB has no `ALTER VIEW ... AS`. */
export function alterViewDdl(
  schemaName: string,
  view: Pick<ViewInfo, 'name' | 'sql' | 'columnAliases'>,
): string {
  return viewStatement('CREATE OR REPLACE VIEW', schemaName, view);
}

function viewStatement(
  head: string,
  schemaName: string,
  view: Pick<ViewInfo, 'name' | 'sql' | 'columnAliases'>,
): string {
  const aliases =
    view.columnAliases.length > 0 ? ` (${view.columnAliases.map(quoteIdentifier).join(', ')})` : '';
  return `${head} ${qualifiedName(schemaName, view.name)}${aliases} AS ${view.sql};`;
}

/** `"name" TYPE [DEFAULT <expression>] [NOT NULL]`: a column as `CREATE TABLE` defines it. */
export function columnDefinition(column: ColumnInfo): string {
  const parts = [quoteIdentifier(column.name), sqlType(column)];
  if (column.defaultValue !== null) {
    parts.push(`DEFAULT ${column.defaultValue}`);
  }
  if (!column.nullable) {
    parts.push('NOT NULL');
  }
  return parts.join(' ');
}

/** The DuckDB type of a column; nested types are rebuilt from `children` (struct fields, list element, map key and value). */
export function sqlType(column: ColumnInfo): string {
  switch (column.type) {
    case 'struct':
      return `STRUCT(${column.children.map((field) => `${quoteIdentifier(field.name)} ${sqlType(field)}`).join(', ')})`;
    case 'list':
      // The only child is the element.
      return `${column.children.map(sqlType).join('')}[]`;
    case 'map':
      return `MAP(${column.children.map(sqlType).join(', ')})`;
    default:
      return typeName(column.type);
  }
}

/** A DuckLake `decimal(p,s)`, with the precision and the scale as its groups. */
export const DECIMAL = /^decimal\(\s*(\d+)\s*,\s*(\d+)\s*\)$/;

/** DuckDB name of a DuckLake leaf type; other types (e.g. nested ones as a macro stores them) pass through. */
export function typeName(type: string): string {
  const decimal = DECIMAL.exec(type);
  return decimal ? `DECIMAL(${decimal[1]},${decimal[2]})` : (LEAF_TYPES.get(type) ?? type);
}

/**
 * `CREATE OR REPLACE MACRO` with all overloads comma-separated, because a second `CREATE MACRO` of the name fails.
 * Overloaded table macro queries get parentheses, or the comma continues the select list. `head` `CREATE MACRO` fails
 * instead of replacing a macro of the name.
 */
export function macroDdl(
  schemaName: string,
  macro: Pick<MacroInfo, 'name' | 'kind' | 'implementations'>,
  head: MacroHead = 'CREATE OR REPLACE MACRO',
): string {
  const overloaded = macro.implementations.length > 1;
  const body = (sql: string): string =>
    macro.kind === 'scalar' ? sql : `TABLE ${overloaded ? `(${sql})` : sql}`;
  const overloads = macro.implementations.map(
    ({ parameters, sql }) => `(${parameters.map(parameterDefinition).join(', ')}) AS ${body(sql)}`,
  );
  return `${head} ${qualifiedName(schemaName, macro.name)}${overloads.join(', ')};`;
}

export type MacroHead = 'CREATE OR REPLACE MACRO' | 'CREATE MACRO';

/** `DROP MACRO` for all overloads; a table macro needs `TABLE`. */
export function dropMacroDdl(schemaName: string, macro: Pick<MacroInfo, 'name' | 'kind'>): string {
  return `DROP MACRO ${macro.kind === 'table' ? 'TABLE ' : ''}${qualifiedName(schemaName, macro.name)};`;
}

/** `"name" TYPE := default`: a parameter as `CREATE MACRO` defines it. */
export function parameterDefinition({ name, type, defaultValue }: MacroParameter): string {
  return [
    quoteIdentifier(name),
    ...(type === null ? [] : [typeName(type)]),
    ...(defaultValue === null ? [] : [`:= ${defaultValue}`]),
  ].join(' ');
}
