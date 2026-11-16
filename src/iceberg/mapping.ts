// What a sync to Iceberg does with the types and the partitioning of a DuckLake table: Iceberg (format version 2, as
// DuckDB's iceberg extension writes it) lacks some of DuckDB's types. Checked with DuckDB 2.0 against Polaris.
import { quoteIdentifier, typeName } from '../catalog/ddl';
import type { CatalogColumnEntry, PartitioningInfo } from '../catalog/model';

/**
 * The types aantje casts in the copy, by their DuckDB name: unsigned integers to the smallest signed type that holds
 * all of their values; time stamps of seconds and milliseconds to microseconds; JSON and ENUM to text.
 */
const CASTS: Readonly<Record<string, string>> = {
  UTINYINT: 'SMALLINT',
  USMALLINT: 'INTEGER',
  UINTEGER: 'BIGINT',
  UBIGINT: 'DECIMAL(20,0)',
  UHUGEINT: 'DECIMAL(38,0)',
  TIMESTAMP_S: 'TIMESTAMP',
  TIMESTAMP_MS: 'TIMESTAMP',
  JSON: 'VARCHAR',
};

/** The types that the writer converts by itself. */
const WIDENED: Readonly<Record<string, string>> = {
  TINYINT: 'INTEGER',
  SMALLINT: 'INTEGER',
  HUGEINT: 'DECIMAL(38,0)',
};

/** Types that Iceberg format version 2 cannot hold; a table with one of them fails. */
const UNWRITABLE: readonly RegExp[] = [
  /\bTIME WITH TIME ZONE\b/,
  /\bTIMETZ\b/,
  /\bTIME_NS\b/,
  /\bTIMESTAMP_NS\b/,
  /\bTIMESTAMPTZ_NS\b/,
  /\bINTERVAL\b/,
  /\bVARIANT\b/,
  /\bGEOMETRY\b/,
  /\bUNION\(/,
  /\bBIT\b/,
  /\bBIGNUM\b/,
  /\bVARINT\b/,
];

/** The type a column of this DuckDB type is written as, when aantje casts it; undefined when it is written as it is. */
export function castOf(type: string): string | undefined {
  const upper = type.trim().toUpperCase();
  if (CASTS[upper] !== undefined) return CASTS[upper];
  if (upper.startsWith('ENUM(')) return 'VARCHAR';
  // An array of fixed length is a list in Iceberg.
  const array = /^(.*)\[\d+\]$/.exec(type.trim());
  return array ? `${array[1]}[]` : undefined;
}

/** Whether Iceberg format version 2 can hold the type, nested types looked into. */
export const isWritable = (type: string): boolean =>
  !UNWRITABLE.some((pattern) => pattern.test(type.toUpperCase()));

/**
 * The select list of a table from its DuckDB columns: `*`, or the columns with the casts; `converted` names every column
 * that Iceberg gets as another type, cast here or widened by the writer, for example `id: UBIGINT as DECIMAL(20,0)`.
 */
export function selectList(columns: readonly (readonly [string, string])[]): {
  list: string;
  converted: string[];
} {
  const converted: string[] = [];
  let cast = false;
  const parts = columns.map(([name, type]) => {
    const to = castOf(type);
    const widened = WIDENED[type.trim().toUpperCase()];
    if (to === undefined) {
      if (widened !== undefined) converted.push(`${name}: ${type} as ${widened}`);
      return quoteIdentifier(name);
    }
    cast = true;
    converted.push(`${name}: ${type} as ${to}`);
    return `CAST(${quoteIdentifier(name)} AS ${to}) AS ${quoteIdentifier(name)}`;
  });
  return { list: cast ? parts.join(', ') : '*', converted };
}

/** What a copy does with the columns of one table, from the catalog: before anything is written. */
export interface TablePlan {
  readonly schema: string;
  readonly table: string;
  /** `column: TYPE as TYPE` of the columns that Iceberg gets as another type. */
  readonly converted: readonly string[];
  /** `column: TYPE` of the columns that Iceberg cannot hold: the copy of the table fails. */
  readonly unwritable: readonly string[];
}

/** The plan of one table from the columns of the catalog (DuckLake type names; nested fields have longer paths). */
export function tablePlan(
  table: { readonly schema: string; readonly table: string },
  columns: readonly CatalogColumnEntry[],
): TablePlan {
  const converted: string[] = [];
  const unwritable: string[] = [];
  for (const column of columns) {
    const type = typeName(column.type);
    const name = column.path.join('.');
    const top = column.path.length === 1;
    const to = top ? (castOf(type) ?? WIDENED[type.toUpperCase()]) : undefined;
    if (to !== undefined) converted.push(`${name}: ${type} as ${to}`);
    // A nested field is not cast: a type that needs a cast fails there as well.
    else if (!isWritable(type) || (!top && castOf(type) !== undefined)) unwritable.push(`${name}: ${type}`);
  }
  return { ...table, converted, unwritable };
}

/** DuckLake transforms that Iceberg has under the same name. */
const TRANSFORMS = new Set(['year', 'month', 'day', 'hour']);

/**
 * The `PARTITIONED BY` list of a table: identity and the time transforms of top-level columns. Undefined when the table
 * is not partitioned or when a key cannot be written as an Iceberg transform (then the copy is not partitioned).
 */
export function partitionedBy(partitioning: PartitioningInfo | undefined): string | undefined {
  if (!partitioning || partitioning.columns.length === 0) return undefined;
  const keys = partitioning.columns.map(({ path, transform }) => {
    const [column, ...nested] = path;
    if (column === undefined || nested.length > 0) return undefined;
    if (transform === 'identity') return quoteIdentifier(column);
    return TRANSFORMS.has(transform) ? `${transform}(${quoteIdentifier(column)})` : undefined;
  });
  return keys.every((key) => key !== undefined) ? keys.join(', ') : undefined;
}
