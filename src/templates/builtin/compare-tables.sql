-- aantje-template: 1
-- name: Compare two tables
-- description: Lists the rows that only one of two tables with the same columns has, with the side that has them: the rows of A that B lacks, then those of B that A lacks.
-- tags: compare, diff, except, reconcile, data quality
-- created: 2026-11-17
-- param: schema_a | identifier | main | Schema of table A
-- param: table_a  | identifier |      | Table A
-- param: schema_b | identifier | main | Schema of table B
-- param: table_b  | identifier |      | Table B, with the columns of A in the same order
-- param: limit    | number     |      | Rows to show at most
-- EXCEPT compares whole rows and takes two NULLs as equal. A row that both tables have is not listed, even when one
-- has it more often than the other.
SELECT 'only in A' AS side, *
FROM (SELECT * FROM {{schema_a}}.{{table_a}} EXCEPT SELECT * FROM {{schema_b}}.{{table_b}})
UNION ALL
SELECT 'only in B' AS side, *
FROM (SELECT * FROM {{schema_b}}.{{table_b}} EXCEPT SELECT * FROM {{schema_a}}.{{table_a}})
ORDER BY ALL
LIMIT $limit{1000};
