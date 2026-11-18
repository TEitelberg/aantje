-- aantje-template: 1
-- name: Duplicate keys
-- description: Lists the values of a key column that more than one row has, with the number of those rows, the most frequent first. The key is one column; for a key of several, add the others to SELECT and GROUP BY.
-- tags: data quality, duplicates, key, check
-- created: 2026-11-17
-- param: schema    | identifier | main | Schema of the table
-- param: table     | identifier |      | Table to check
-- param: id_column | identifier | id   | Column whose values should each have one row
-- param: limit     | number     |      | Key values to show at most
-- The rows whose key is NULL count as one key.
SELECT {{id_column}}, count(*) AS row_count
FROM {{schema}}.{{table}}
GROUP BY {{id_column}}
HAVING count(*) > 1
ORDER BY row_count DESC, {{id_column}}
LIMIT $limit{1000};
