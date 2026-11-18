-- aantje-template: 1
-- name: Top N per group
-- description: Lists the rows with the largest values of a measure in each group, with their place in the group, such as the biggest orders of each customer.
-- tags: analysis, top n, ranking, window, qualify
-- created: 2026-11-17
-- param: schema         | identifier | main | Schema of the table
-- param: table          | identifier |      | Table
-- param: group_column   | identifier |      | Column whose values form the groups
-- param: measure_column | identifier |      | Column to rank the rows of a group by, the largest first
-- param: n              | number     |      | Rows of each group
-- Rows with the same value get their places in any order; rank() in place of row_number() gives them the same place.
SELECT *, row_number() OVER (PARTITION BY {{group_column}} ORDER BY {{measure_column}} DESC NULLS LAST) AS place
FROM {{schema}}.{{table}}
QUALIFY place <= $n{5}
ORDER BY {{group_column}}, place;
