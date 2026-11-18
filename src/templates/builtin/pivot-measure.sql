-- aantje-template: 1
-- name: Pivot a measure
-- description: Turns the values of a category column into columns: one row per value of a row column, and per category the sum of a measure, such as the revenue of each region per month.
-- tags: analysis, pivot, crosstab, report
-- created: 2026-11-17
-- param: schema          | identifier | main | Schema of the table
-- param: table           | identifier |      | Table
-- param: row_column      | identifier |      | Column whose values become the rows
-- param: category_column | identifier |      | Column whose values become the columns; it should have few of them
-- param: measure_column  | identifier |      | Number column to sum in each cell
PIVOT {{schema}}.{{table}}
ON {{category_column}}
USING sum({{measure_column}})
GROUP BY {{row_column}}
ORDER BY {{row_column}};
