-- aantje-template: 1
-- name: Outliers by z-score
-- description: Lists the rows whose value of a number column lies more than a number of standard deviations from the mean of the column, with that distance (the z-score), the farthest first.
-- tags: data quality, outliers, z-score, statistics, anomalies
-- created: 2026-11-17
-- param: schema        | identifier | main | Schema of the table
-- param: table         | identifier |      | Table
-- param: number_column | identifier |      | Number column to check
-- param: z             | number     |      | Standard deviations from the mean beyond which a value is an outlier
-- param: limit         | number     |      | Rows to show at most
-- The mean and the standard deviation are those of all rows of the table; a NULL value is no outlier.
SELECT *
FROM (
  SELECT *, ({{number_column}} - avg({{number_column}}) OVER ()) / stddev_samp({{number_column}}) OVER () AS z_score
  FROM {{schema}}.{{table}}
)
WHERE abs(z_score) > $z{3}
ORDER BY abs(z_score) DESC
LIMIT $limit{1000};
