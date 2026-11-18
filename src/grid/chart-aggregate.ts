// Aggregate in DuckDB: the statement of a result that has more rows than were loaded, run again in the session of its
// editor and aggregated by the X of its chart, so that a large result becomes a small chart of all its rows. The
// column names come from the result: every one is a quoted identifier.
import { quoteIdentifier } from '../catalog/ddl';
import { aggregates, chartUse } from './result-chart';
import type { ChartChoice } from './result-chart';

const RESULT = 'aantje_result';

/**
 * `SELECT x[, series], agg(y)... FROM (<statement>) GROUP BY ALL ORDER BY x[, series]`, named like the columns of the
 * result, so that the chart draws the rows with the same choice. A count is named `count`. A calendar counts per day.
 * Undefined for a chart that does not combine rows by X, without X, or without a way to combine them.
 */
export function aggregateQuery(statement: string, choice: ChartChoice): string | undefined {
  if (!aggregates(choice.type) || choice.x === null || choice.aggregate === 'none') return undefined;
  const use = chartUse(choice.type);
  const x = quoteIdentifier(choice.x);
  const keys = [
    `${choice.type === 'calendar' ? `CAST(${x} AS DATE)` : x} AS ${x}`,
    ...(use.series && choice.series !== null ? [quoteIdentifier(choice.series)] : []),
  ];
  const ys = choice.y.slice(0, use.y === Infinity ? undefined : use.y);
  if (choice.aggregate !== 'count' && ys.length === 0) return undefined;
  const values =
    choice.aggregate === 'count'
      ? [`count(*) AS ${quoteIdentifier('count')}`]
      : ys.map((name) => `${choice.aggregate}(${quoteIdentifier(name)}) AS ${quoteIdentifier(name)}`);
  const order = keys.map((_, index) => String(index + 1)).join(', ');
  return `SELECT ${[...keys, ...values].join(', ')} FROM (\n${statement}\n) AS ${RESULT} GROUP BY ALL ORDER BY ${order}`;
}
