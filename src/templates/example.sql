-- aantje-template: 1
-- name: Example: orders of a customer since a day
-- description: Lists the newest orders of one customer since a day. A start for templates of your own.
-- tags: example, orders, customer
-- created: 2026-11-16
-- param: schema   | identifier | main       | Schema of the table
-- param: table    | identifier | orders     | Table with the orders
-- param: customer | text       |            | Customer whose orders to list
-- param: since    | date       | 2026-01-01 | First day of the orders
-- param: max_rows | number     | 100        | Most rows to show
--
-- How aantje reads this file: the comment lines at the top are the header of the template, the rest is its SQL.
-- A header line is "-- field: value". The fields:
--   aantje-template   the format of the file, 1. Without this line the file is no template.
--   name              the name of the template in the list. Required.
--   description       one line on what the template does. Optional.
--   tags              words to find the template by, separated by commas. Optional.
--   created           the day the template was created, YYYY-MM-DD. Optional. Recently created on the page sorts the
--                     templates of a folder by it; a template of your own or an imported one has the time aantje kept
--                     it first.
--   param             one line per parameter: name | type | default | description. Only the name is required.
--                     The types: text (the default type), number, date (YYYY-MM-DD) and identifier (a name).
-- Other comment lines in the header, like these, stay comments.
--
-- Two kinds of placeholders go into the SQL:
--   {{name}}   is filled in when you use the template: an identifier becomes a quoted name ("orders"), a text a
--              quoted literal ('ACME'), a number the number, a date DATE '2026-01-01'. Names go here.
--   $name      stays in the SQL; the run asks for its value and binds it, so a value never becomes SQL text.
-- A placeholder in a comment or a string is none, and one that the header does not declare is a text.
--
-- A template keeps no secret: aantje refuses a template whose header, defaults or statements hold a password,
-- key or token. A parameter named like a secret (key, secret, token, password, credential) has no default.
--
-- Several templates can go into one .json file for Import..., each with its whole text:
--   { "aantje-templates": 1, "templates": [ { "text": "-- aantje-template: 1\n-- name: First\nSELECT 1;" } ] }
SELECT *
FROM {{schema}}.{{table}}
WHERE customer = {{customer}}
  AND order_date >= $since
ORDER BY order_date DESC
LIMIT $max_rows;
