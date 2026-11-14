import type * as Duckdb from '@duckdb/node-api';
import type { GridColumn, GridValue } from './types';

/** The columns of a result for the grid: name, DuckDB type and the kind that decides alignment and filters. */
export function gridColumns(reader: Duckdb.DuckDBResultReader): GridColumn[] {
  return reader.columnNames().map((name, index): GridColumn => {
    const type = typeOf(reader, index);
    return { name, type, kind: kindOf(type) };
  });
}

/** The DuckDB type of a result column as text, for example `DECIMAL(18,3)`. */
export function typeOf(reader: Duckdb.DuckDBResultReader, index: number): string {
  return reader.columnTypes()[index]?.toString() ?? '';
}

export function kindOf(type: string): GridColumn['kind'] {
  if (/^U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)$|^(FLOAT|DOUBLE)$|^DECIMAL\(\d+,\d+\)$/.test(type))
    return 'number';
  if (type === 'BOOLEAN') return 'boolean';
  // Lists and arrays end in "[]" / "[n]"; structs, maps and unions start with their keyword; INTERVAL arrives as an
  // object.
  if (/^(STRUCT|MAP|UNION)\(|\]$|^INTERVAL$/.test(type)) return 'nested';
  return 'text';
}

/** Turns nested values (objects, arrays) into compact JSON text; other values pass through. */
export function toGridValue(value: Duckdb.Json): GridValue {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
}
