-- aantje-template: 1
-- name: Missing days in a date series
-- description: Lists the days between the first and the last day of a date or timestamp column on which the table has no row, such as the days that a daily load missed.
-- tags: data quality, gaps, dates, time series, completeness
-- created: 2026-11-17
-- param: schema      | identifier | main | Schema of the table
-- param: table       | identifier |      | Table that should have rows of every day
-- param: date_column | identifier | day  | Date or timestamp column; a timestamp counts by its day
WITH days AS (
  SELECT DISTINCT CAST({{date_column}} AS DATE) AS day
  FROM {{schema}}.{{table}}
  WHERE {{date_column}} IS NOT NULL
),
series AS (
  SELECT CAST(unnest(generate_series(CAST(first_day AS TIMESTAMP), CAST(last_day AS TIMESTAMP), INTERVAL 1 DAY)) AS DATE) AS day
  FROM (SELECT min(day) AS first_day, max(day) AS last_day FROM days)
)
SELECT series.day AS missing_day
FROM series
ANTI JOIN days ON series.day = days.day
ORDER BY missing_day;
