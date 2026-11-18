-- aantje-template: 1
-- name: Data freshness
-- description: Shows the newest time of a timestamp column, how many hours ago that was, and whether that is within a limit (ok) or not (stale), such as the check of a load.
-- tags: data quality, freshness, monitoring, check, load
-- created: 2026-11-17
-- param: schema      | identifier | main | Schema of the table
-- param: table       | identifier |      | Table that a load fills
-- param: time_column | identifier | ts   | Timestamp or date column of when a row arrived or happened
-- param: hours       | number     |      | Hours after which the data counts as stale
-- A timestamp without a time zone counts as UTC. An empty table is stale.
SELECT
  newest,
  round(age_hours, 1) AS age_hours,
  CASE WHEN age_hours <= $hours{24} THEN 'ok' ELSE 'stale' END AS status
FROM (
  SELECT newest, (epoch(now()) - epoch(newest)) / 3600 AS age_hours
  FROM (SELECT max({{time_column}}) AS newest FROM {{schema}}.{{table}})
);
