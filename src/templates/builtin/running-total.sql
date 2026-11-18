-- aantje-template: 1
-- name: Running total and moving average
-- description: Sums a measure per day, with the running total up to each day and the average of the days of a span that ends with it, such as the revenue of each day.
-- tags: analysis, running total, moving average, window, time series
-- created: 2026-11-17
-- param: schema         | identifier | main | Schema of the table
-- param: table          | identifier |      | Table
-- param: time_column    | identifier | ts   | Date or timestamp column; a timestamp counts by its day
-- param: measure_column | identifier |      | Number column to sum
-- param: days           | number     |      | Days of the moving average, the day itself included
-- A day without rows has no line; the moving average takes the days of its span that have one.
WITH daily AS (
  SELECT CAST({{time_column}} AS DATE) AS day, sum({{measure_column}}) AS total
  FROM {{schema}}.{{table}}
  WHERE {{time_column}} IS NOT NULL
  GROUP BY ALL
)
SELECT
  day,
  total,
  sum(total) OVER (ORDER BY day) AS running_total,
  avg(total) OVER (ORDER BY day RANGE BETWEEN to_days(CAST($days{7} AS INTEGER) - 1) PRECEDING AND CURRENT ROW) AS moving_average
FROM daily
ORDER BY day;
