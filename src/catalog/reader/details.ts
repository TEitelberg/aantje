import { quoteLiteral, typeName } from '../ddl';
import type { Row } from '../drivers/driver';
import type {
  CatalogReader,
  MacroInfo,
  MacroParameter,
  PartitioningInfo,
  SortOrderInfo,
  TagsInfo,
} from '../model';
import * as queries from '../queries/objects';
import { compareText, groupBy } from '../../order';
import { columnPaths, readColumns } from './columns';
import { toNumber, toNumberOrNull, toText, toTextOrNull } from './rows';
import type { Attempt, Run } from './rows';

/** The partitioning in the rows of `queries.partitionings`; undefined for none (a reset has no columns). */
export function partitioningOf(
  rows: readonly Row[],
  paths: ReadonlyMap<number, string[]>,
): PartitioningInfo | undefined {
  const [head] = rows;
  const keys = rows.filter(
    (row) => toNumber(row.partition_id) === toNumber(head?.partition_id) && row.column_id !== null,
  );
  if (!head || keys.length === 0) return undefined;
  return {
    id: toNumber(head.partition_id),
    beginSnapshot: toNumber(head.begin_snapshot),
    endSnapshot: toNumberOrNull(head.end_snapshot),
    columns: keys.map((row) => {
      const columnId = toNumber(row.column_id);
      return {
        columnId,
        path: paths.get(columnId) ?? [`#${columnId}`],
        transform: toText(row.transform),
      };
    }),
  };
}

// DuckLake writes the type `unknown` for an untyped parameter.
function macroParameter(row: Row): MacroParameter {
  const type = toTextOrNull(row.parameter_type);
  return {
    name: toText(row.parameter_name),
    type: type === 'unknown' ? null : type,
    defaultValue: macroDefault(toTextOrNull(row.default_value), toTextOrNull(row.default_value_type)),
  };
}

// "No default" is the text `NULL` of type `unknown`. A constant is stored as text plus type (`1.19` `decimal(3,2)`),
// any other expression as SQL text. A literal DuckDB reads as the same type stays bare, anything else is a cast.
function macroDefault(value: string | null, valueType: string | null): string | null {
  if (value === null || (value === 'NULL' && valueType === 'unknown')) {
    return null;
  }
  if (valueType === 'expression') {
    return value;
  }
  if (valueType === 'null') {
    return 'NULL';
  }
  if (valueType === 'varchar') {
    return quoteLiteral(value);
  }
  const [, whole = '', fraction = ''] = /^-?(\d+)\.(\d+)$/.exec(value) ?? [];
  const bare =
    valueType === 'boolean' ||
    valueType === 'int32' ||
    (fraction !== '' && valueType === `decimal(${whole.length + fraction.length},${fraction.length})`);
  return bare ? value : `CAST(${quoteLiteral(value)} AS ${typeName(valueType ?? 'varchar')})`;
}

// Groups rows (one per parameter) by macro and implementation.
function macrosOf(rows: readonly Row[]): MacroInfo[] {
  return Array.from(
    groupBy(rows, (row) => toNumber(row.macro_id)),
    ([id, ofMacro]) => {
      const [head] = ofMacro;
      return {
        id,
        schemaId: toNumber(head?.schema_id),
        name: toText(head?.macro_name),
        kind: head?.type === 'table' ? 'table' : 'scalar',
        implementations: Array.from(
          groupBy(ofMacro, (row) => toNumber(row.impl_id)).values(),
          (rowsOfImplementation) => ({
            dialect: toText(rowsOfImplementation[0]?.dialect),
            sql: toText(rowsOfImplementation[0]?.sql),
            parameters: rowsOfImplementation.filter((row) => row.parameter_name !== null).map(macroParameter),
          }),
        ),
      };
    },
  );
}

type DetailReads = Pick<CatalogReader, 'partitioning' | 'sortOrder' | 'tags' | 'macros'>;

/** Reads of what hangs off a table or schema: partitioning, sort order, tags and macros. */
export function detailReads(run: Run, attempt: Attempt): DetailReads {
  return {
    async partitioning(tableId, snapshot, columns): Promise<PartitioningInfo | undefined> {
      const rows = (await attempt(queries.partitionings(tableId, snapshot))) ?? [];
      return rows.length === 0
        ? undefined
        : partitioningOf(rows, columnPaths(columns ?? (await readColumns(run, tableId, snapshot))));
    },

    async sortOrder(tableId, snapshot): Promise<SortOrderInfo | undefined> {
      const rows = (await attempt(queries.sortExpressions(tableId, snapshot))) ?? [];
      const expressions = rows.filter((row) => row.expression !== null);
      const [first] = expressions;
      return first
        ? {
            id: toNumber(first.sort_id),
            beginSnapshot: toNumber(first.begin_snapshot),
            endSnapshot: toNumberOrNull(first.end_snapshot),
            expressions: expressions.map((row) => ({
              expression: toText(row.expression),
              dialect: toText(row.dialect),
              direction: toText(row.sort_direction),
              nullOrder: toText(row.null_order),
            })),
          }
        : undefined;
    },

    async tags(tableId, snapshot, columns): Promise<TagsInfo> {
      const rows = (await attempt(queries.tags(tableId, snapshot))) ?? [];
      const ofColumns = rows.filter((row) => row.column_id !== null);
      const paths =
        ofColumns.length > 0
          ? columnPaths(columns ?? (await readColumns(run, tableId, snapshot)))
          : new Map<number, string[]>();
      const entry = (row: Row) => ({ key: toText(row.key), value: toText(row.value) });
      return {
        table: rows
          .filter((row) => row.column_id === null)
          .map(entry)
          .toSorted((a, b) => compareText(a.key, b.key)),
        columns: ofColumns
          .map((row) => {
            const columnId = toNumber(row.column_id);
            return { ...entry(row), columnId, path: paths.get(columnId) ?? [`#${columnId}`] };
          })
          .toSorted((a, b) => a.columnId - b.columnId || compareText(a.key, b.key)),
      };
    },

    async macros(schemaId, snapshot): Promise<MacroInfo[]> {
      return macrosOf((await attempt(queries.macros(schemaId, snapshot))) ?? []);
    },
  };
}
