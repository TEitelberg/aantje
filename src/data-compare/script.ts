import { quoteIdentifier } from '../catalog/ddl';
import { commentName, commentText } from '../ddl-script/names';
import { atVersion } from '../script';
import { isCast } from './model';
import type { ColumnPlan, CompareCounts, CompareSide, MatchedColumn } from './model';

/** What Script as Update needs of a compare. */
export interface ScriptInput {
  readonly source: CompareSide;
  readonly target: CompareSide;
  readonly plan: ColumnPlan;
  readonly key: readonly string[];
  readonly counts: CompareCounts;
  /** The alias of the source lake in the session of the document, for a source of another connection. */
  readonly sourceAlias: string | undefined;
}

const q = quoteIdentifier;

/**
 * `"source_lake"."staging"."orders" AS s AT (VERSION => 56)`: the source as the compare read it. DuckDB takes the alias
 * of a relation before its `AT`, not after it.
 */
function sourceRelation({ source, sourceAlias }: ScriptInput, alias?: string): string {
  const name = `${q(source.schema)}.${q(source.table)}`;
  return `${sourceAlias === undefined ? name : `${q(sourceAlias)}.${name}`}${alias === undefined ? '' : ` AS ${alias}`}${atVersion(source.snapshot)}`;
}

const targetRelation = ({ target }: ScriptInput): string => `${q(target.schema)}.${q(target.table)}`;

// A value of the target in the terms of the compare: cast to the type of the source where the types differ.
const targetValue = (column: MatchedColumn, alias: string): string =>
  isCast(column)
    ? `TRY_CAST(${alias}.${q(column.target)} AS ${column.sourceType})`
    : `${alias}.${q(column.target)}`;

// A value of the source to write into the target: cast to the type of the target where the types differ.
const written = (column: MatchedColumn, alias: string): string =>
  isCast(column)
    ? `CAST(${alias}.${q(column.source)} AS ${column.targetType})`
    : `${alias}.${q(column.source)}`;

const names = (list: readonly string[]): string => list.map((name) => commentText(q(name))).join(', ');

function header(input: ScriptInput): string[] {
  const { source, target, plan } = input;
  const side = (s: CompareSide): string =>
    `${commentText(s.connectionName)} · ${commentName(s.schema, s.table)} @${s.snapshot}`;
  return [
    '-- Script as Update (Data Compare): makes the rows of the table on the right (target) like the rows of the table on the left (source). Nothing has run: read the statements, change what you need and run them in a read/write SQL session.',
    `-- Source: ${side(source)}. Target: ${side(target)}.`,
    `-- The source is read at snapshot ${source.snapshot}, as compared; the statements act on the newest state of the target.`,
    ...(input.sourceAlias === undefined
      ? []
      : [
          `-- The session of this document has the source connection ${commentText(JSON.stringify(source.connectionName))} attached read-only as ${commentText(q(input.sourceAlias))}, with its credentials; the script names no credential.`,
        ]),
    ...(plan.onlyInSource.length > 0
      ? [
          `-- Not written: the columns that only the source has (${names(plan.onlyInSource)}). Schema Compare adds them to the target.`,
        ]
      : []),
    ...(plan.notCast.length > 0
      ? [
          `-- Not written: the columns whose values in the target do not cast to the type of the source (${names(plan.notCast.map((c) => c.source))}); the compare left them out.`,
        ]
      : []),
    ...(plan.onlyInTarget.length > 0
      ? [
          `-- Not touched: the columns that only the target has (${names(plan.onlyInTarget)}); a new row gets their default.`,
        ]
      : []),
    '',
  ];
}

// With a key: MERGE updates and inserts; DuckLake allows one UPDATE or DELETE action per MERGE, so the rows that only
// the target has go in a DELETE of their own.
function keyedStatements(input: ScriptInput): string[] {
  const { plan, key, counts } = input;
  const keys = plan.compared.filter((column) => key.includes(column.source));
  const others = plan.compared.filter((column) => !key.includes(column.source));
  const matches = (s: string, t: string): string =>
    keys
      .map((column) => `${s}.${q(column.source)} IS NOT DISTINCT FROM ${targetValue(column, t)}`)
      .join(' AND ');
  const sourceList = plan.compared.map((column) => q(column.source)).join(', ');
  const update =
    others.length === 0
      ? []
      : [
          `WHEN MATCHED AND (${others.map((column) => `${targetValue(column, 't')} IS DISTINCT FROM s.${q(column.source)}`).join(' OR ')})`,
          `  THEN UPDATE SET ${others.map((column) => `${q(column.target)} = ${written(column, 's')}`).join(', ')}`,
        ];
  return [
    'BEGIN TRANSACTION;',
    `MERGE INTO ${targetRelation(input)} AS t`,
    `USING (SELECT ${sourceList} FROM ${sourceRelation(input)}) AS s`,
    `ON ${matches('s', 't')}`,
    ...update,
    `WHEN NOT MATCHED THEN INSERT (${plan.compared.map((column) => q(column.target)).join(', ')}) VALUES (${plan.compared.map((column) => written(column, 's')).join(', ')});`,
    `-- Warning: this deletes the rows that only the target has (${counts.onlyInTarget} at the compare).`,
    `DELETE FROM ${targetRelation(input)} AS t`,
    `WHERE NOT EXISTS (SELECT 1 FROM ${sourceRelation(input, 's')} WHERE ${matches('s', 't')});`,
    'COMMIT;',
  ];
}

// Without a key the rows cannot be matched: the content of the target is replaced.
function replaceStatements(input: ScriptInput): string[] {
  const { plan } = input;
  return [
    'BEGIN TRANSACTION;',
    `-- Warning: this replaces the content of the target: it deletes all its rows (${input.counts.onlyInTarget + input.counts.equal} at the compare) and inserts the rows of the source.`,
    `DELETE FROM ${targetRelation(input)};`,
    `INSERT INTO ${targetRelation(input)} (${plan.compared.map((column) => q(column.target)).join(', ')})`,
    `SELECT ${plan.compared.map((column) => written(column, 's')).join(', ')} FROM ${sourceRelation(input, 's')};`,
    'COMMIT;',
  ];
}

/**
 * Script as Update of Data Compare: the statements that make the rows of the target like the rows of the source as
 * compared, for a new SQL document of the target connection. Every name is quoted; the only other text from the catalog
 * is the SQL type of a column whose types differ.
 */
export function updateScript(input: ScriptInput): string {
  return [
    ...header(input),
    ...(input.key.length > 0 ? keyedStatements(input) : replaceStatements(input)),
    '',
  ].join('\n');
}
