# SQL IntelliSense

The SQL editor of aantje completes, explains and checks SQL while you type: tables, views, columns and aliases from the catalog, the columns of CTEs, subqueries and VALUES lists from the SQL text, the keywords, functions and types of DuckDB and its own SQL (PIVOT, lambdas, `* EXCLUDE`, window frames, FROM-first queries, the options of COPY and of `read_csv`), the functions and statement shapes of DuckLake, hover texts, signature help, red marks for syntax errors and warnings, with a quick fix, for the tables, views and columns that the lake does not have. The logic lives in `src/sql` and is free of the VS Code API; `src/sql/language.vscode.ts` maps its results to VS Code types. A document without a connection gets nothing from it; the [SQL editor](sql-editor.md) decides which documents belong to a connection.

| Feature        | What                                                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Completion     | Columns (also of structs), lambda parameters, tables, views, schemas, aliases, macros, functions, named arguments, options of `COPY ... TO`, keywords, types, settings, snapshots, DuckLake snippets. Trigger characters are `.`, `"` and `'`; VS Code's word trigger does the rest. |
| Hover          | A column (type, nullability, default, comment), a table (comment, rows, files, size, partition keys, sort keys) or view (comment, definition), a schema, an alias, a function (signatures, description, examples), a macro.                                                          |
| Signature help | The parameters of a function or macro, the one being typed marked; named arguments (`header := true`, `dry_run => true`) are followed.                                                                                                                                               |
| Marks          | A red mark with DuckDB's parser message a moment after the last keystroke; a warning on a table, view or column that the lake certainly lacks, with a quick fix that puts in the nearest known name ([Unknown names](#unknown-names)).                                               |

The columns of a view are offered and explained once the connection's views are trusted ([Columns of views](#columns-of-views)).

## Public API

```ts
// src/sql/language.ts
export function openLanguageService(options?: {
  extensionDirectory?: string;
  logger?: Logger;
}): LanguageService;

export interface LanguageService {
  tokenize(text: string): Promise<SqlToken[]>;
  vocabulary(): Promise<Vocabulary>;
  diagnose(text: string, source?: string, catalog?: SqlCatalog): Promise<readonly Problem[] | undefined>;
  complete(text: string, offset: number, catalog: SqlCatalog): Promise<Completions | undefined>;
  hover(text: string, offset: number, catalog: SqlCatalog): Promise<Hover | undefined>;
  signature(text: string, offset: number, catalog: SqlCatalog): Promise<SignatureHelp | undefined>;
  dispose(): Promise<void>;
}

// src/sql/problems.ts
export interface Problem {
  readonly offset: number;
  readonly length: number;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  /** What a quick fix can put in place of the range, the nearest first, quoted where the name needs it. */
  readonly replacements: readonly string[];
}
export function quickFixes(problem: Problem): QuickFix[]; // { title, offset, length, text }

// src/sql/language.vscode.ts
export function registerSqlLanguage(deps: SqlLanguageDeps): vscode.Disposable;
// deps: service, logger, connectionOf(document), catalogOf(document), debounceMs, onDidChangeConnection?, onDidChangeCatalog?
```

- All offsets are UTF-16 offsets into the text, as the editor counts. DuckDB reports UTF-8 byte offsets; the service converts them (`utf16Offsets`, `src/sql/script.ts`, shared with the SQL session).
- The service owns a tiny in-memory DuckDB that attaches nothing, loads no extension and is created with `enable_external_access=false`, `autoinstall_known_extensions=false`, `autoload_known_extensions=false` and `allow_persistent_secrets=false`. `sql_tokenize`, `json_serialize_sql` and the `duckdb_*` functions need none of that, so it cannot read a file or reach a network. It is created on the first call and closed by `dispose()`.
- `registerSqlLanguage` registers a completion provider (`.`, `"`, and `'` for the snapshot times), a hover provider, a signature help provider (`(` and `,`), a code action provider for the quick fixes and the diagnostic collection `aantje-sql` for documents of the language `sql` with the scheme `untitled` or `file`. `connectionOf` decides which documents take part, also for the syntax check, which needs no catalog. `catalogOf` gives the catalog of that connection; while it returns `undefined` (not connected), keywords, functions and types still complete and only the syntax is checked. An item whose `snippet` is true is inserted as a `SnippetString`. Marks are removed when the document closes; `onDidChangeCatalog` (the explorer reads the lake again) checks the open documents again.

`src/extension.ts` creates one service, builds one `SqlCatalog` per connection with `catalogOfReader` at the newest snapshot that the explorer knows (again when the explorer reloads; `catalogCache`, `src/sql/editor.ts`) and disposes the service on deactivation. It is the snapshot that the SQL session queries, so completion follows it also while the tree shows a pinned snapshot. The catalog binds views through `trustedViewColumns` ([Columns of views](#columns-of-views)).

## The catalog port

The service reads the lake through a port at one snapshot (`src/sql/catalog.ts`):

```ts
export interface SqlCatalog {
  readonly lake: string;
  schemas(): Promise<readonly SchemaInfo[]>;
  entries(): Promise<readonly SqlEntry[]>;
  columns(schema: string, table: string): Promise<readonly ColumnInfo[]>;
  columnsPending(schema: string, table: string): Promise<void> | undefined;
  viewsTrusted(): boolean;
  macros(schema: string): Promise<readonly MacroInfo[]>;
  snapshots(): Promise<readonly SnapshotInfo[]>;
  layout(schema: string, table: string): Promise<TableLayout>;
  at(snapshot: SnapshotId): SqlCatalog;
}
export interface ViewColumnSource {
  trusted(): boolean;
  read(schema: SchemaInfo, view: ViewInfo, snapshot: SnapshotId): Promise<readonly RelationColumn[]>;
  failed(schema: SchemaInfo, view: ViewInfo, error: unknown): void;
}
export function catalogOfReader(
  reader: CatalogReader,
  snapshot: SnapshotId,
  lake?: string,
  views?: ViewColumnSource,
): SqlCatalog;
```

- `lake` is the name the lake is attached as (`lake` in the SQL session); it is needed for `lake.sales.orders` and for the functions of the lake.
- The types are the catalog reader's model, so the hover texts are the tree's tooltips and the two agree.
- `catalogOfReader` caches every read for the life of the object (a failed read is retried); make a new one when the snapshot or catalog changes.
- `columns` of a view comes from `views` ([Columns of views](#columns-of-views)); without `views`, a view has no columns and `viewsTrusted()` is false. `columnsPending` is the read of a view's columns that `columns` started, while it runs.
- `layout` gives the partitioning and the sort order of a table at the snapshot (the reader's `partitioning` and `sortOrder`), for the hover.
- `at` gives the same lake at another snapshot. `catalogOfReader` keeps the catalogs of the four snapshots asked for last besides its own, each with its own cache.
- A read that fails counts as "nothing", so completion degrades to keywords and functions. A failure of the service itself (DuckDB cannot start, a parse throws) is logged once per feature to the "aantje" output channel (`failureLog`, `src/log-once.ts`), not once per keystroke.

## How the context is determined

`contextAt(tokens, offset, lake)` (`src/sql/context.ts`) is a pure function of the tokens of `sql_tokenize`. It reads the statement that contains the cursor with a stack of parentheses and reports:

- **Inert:** the cursor is inside a string literal (also `$$` blocks), a comment or a number. Nothing is offered, except in the string of `AT (TIMESTAMP => '...')` and the number of `AT (VERSION => ...)`: there the ranges cover the literal (without its quotes) and the snapshots are offered.
- **The word and the dotted prefix:** the word before the cursor and the names before its dots (`lake.sales.or` gives `lake`, `sales`, `or`). Quoted words work, also with `""` inside a name.
- **The position** (`positionOf`, `src/sql/position.ts`), which decides what is offered:

| Position                                                    | Where                                                                                                                                                       | Offered                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `statement`                                                 | start of a statement or subquery, after UNION                                                                                                               | statement keywords                                                                                                          |
| `keyword`                                                   | after a table or alias, after `CREATE TABLE t`, inside `OVER (` and its frame                                                                               | the next clauses (or parts of the window), then all keywords                                                                |
| `from`, `relation`                                          | after FROM, JOIN, PIVOT, UNPIVOT, INSERT INTO, UPDATE, DELETE FROM, DROP TABLE, ALTER TABLE, DESCRIBE, SUMMARIZE                                            | CTEs, schemas, tables, views; in FROM also table macros and functions; after DESCRIBE and SUMMARIZE also SELECT, FROM, WITH |
| `expression`                                                | SELECT list, WHERE, GROUP BY, ORDER BY, HAVING, ON, SET `x =`, function arguments, `COLUMNS(`, PARTITION BY and ORDER BY of a window, ON and USING of PIVOT | lambda parameters, columns in scope, aliases, macros, functions, keywords                                                   |
| `target-column`                                             | `INSERT INTO t (`, `UPDATE t SET`, `ALTER TABLE t DROP COLUMN`, `PARTITION_BY (` of COPY                                                                    | the columns of the table the statement changes                                                                              |
| `column`                                                    | `* EXCLUDE (`, `* RENAME (`, after AS in `* REPLACE (`, the IN list of `UNPIVOT (`                                                                          | the columns in scope, nothing else                                                                                          |
| `value`                                                     | VALUES, LIMIT, arguments of a table function in FROM or CALL, the IN list of PIVOT                                                                          | named arguments, macros, functions, keywords; no columns                                                                    |
| `type`                                                      | after `::`, `CAST(x AS`, `ADD COLUMN c`                                                                                                                     | types                                                                                                                       |
| `schema`, `new-relation`, `column-path`                     | USE, DROP SCHEMA; a table being created; `COMMENT ON COLUMN`                                                                                                | schemas; nothing; tables then columns                                                                                       |
| `snapshot-clause`, `snapshot-version`, `snapshot-timestamp` | inside `AT (`, after or in the number of `VERSION =>`, after or in the string of `TIMESTAMP =>`                                                             | the two keywords, snapshot ids, snapshot times                                                                              |
| `setting`, `call`                                           | after SET and RESET, after CALL                                                                                                                             | DuckDB settings; the lake and the procedures of DuckLake                                                                    |
| `copy-option`, `copy-format`                                | in `COPY ... TO 'file' (` where an option starts, after its FORMAT                                                                                          | the options of the format not given yet; the formats                                                                        |
| `name`                                                      | after `AS`, a new column or table name, the parameters after `lambda`, the file of COPY                                                                     | nothing                                                                                                                     |

- **The relations of the query** are the tables of the FROM and JOIN clauses (also those after the cursor, so `SELECT | FROM sales.orders o` knows `o`) with their aliases, and the tables of UPDATE and DELETE. A name resolves as `table`, `schema.table` or `lake.schema.table`; an unqualified table is in `main`. UNION starts a new query. A subquery sees the outer relations, except as a derived table in FROM or a CTE body.
- **Columns from the text** (`src/sql/context-columns.ts`, resolved against the catalog in `src/sql/lookup.ts`): a CTE, a subquery in FROM and a VALUES list have the columns that their text names; nothing is run to learn them.
  - The select list of the first SELECT (also of a UNION) gives a column (`a`, `t.a`, a field `t.s.f`) under its name and any expression under its alias (`x AS a`, `x a`, `a: x`). A name that reads a column of the catalog has its type and comment, also through other CTEs.
  - `*` and `t.*` give the columns of the relations of that select list, without those of `EXCLUDE` and with the names of `RENAME`; a FROM-first query without SELECT and `TABLE t` give all of them. VALUES gives `col0`, `col1`, ... after its first row.
  - Column aliases rename the first columns by position: after the alias of any relation in FROM (`t x(a, b)`, `(...) s(a, b)`, `(VALUES ...) v(a, b)`, `range(3) r(i)`) and on a CTE (`WITH c(a, b) AS`).
- **Never a guess:** an expression without alias gets a name that DuckDB makes up (`(amount * 2)`), so it is not offered. `COLUMNS(...)`, `UNNEST(...)` and a star with another modifier (`* LIKE ...`) give any number of columns; past them, and past the first relation of a `*` over a join (USING and NATURAL keep a shared column once), no position is known, so column aliases rename nothing there. DuckDB calls a repeated name of a subquery `a_1`: only the first is offered. A table function, a table of another catalog, the result of PIVOT and a CTE or subquery whose text says nothing (PIVOT, a query in parentheses) have no known columns: `alias.` after them offers nothing, and an unqualified column is never offered from such a relation. A clause that is not understood gives `keyword`.
- **DuckDB's own SQL** (`src/sql/context-frames.ts`):
  - A query may start with FROM (`FROM t SELECT a`); the statement is then `FROM`.
  - `PIVOT t ON ... USING ... GROUP BY ...` and `UNPIVOT t ON ... INTO NAME n VALUE v` read their table like FROM; the IN list of PIVOT holds values. In `FROM t PIVOT (sum(x) FOR c IN (...))` the columns of t are in scope inside the parentheses, and t counts as a relation without known columns after them: the result has other columns. In `UNPIVOT (v FOR k IN (...))` the names are new and the IN list holds columns.
  - `lambda x, y: body` makes x and y local columns of the body (`locals`), which ends at the next comma of the call outside brackets or with the call; between `lambda` and `:` names are typed.
  - The `*` of all columns (after SELECT, a comma, `(` or `t.`, not a multiplication) with `EXCLUDE (...)`, `REPLACE (... AS c)` and `RENAME (c AS ...)` opens lists of the columns in scope.
  - `OVER (` and `WINDOW w AS (` follow PARTITION BY, ORDER BY and the frame (ROWS, RANGE or GROUPS, BETWEEN ... AND, the bounds, EXCLUDE); the clause names the part of the window and the word before the cursor, and picks the keywords offered first.
  - `COPY ... TO 'file' (` knows the format, from its FORMAT option or from the file name (`.parquet`, `.json`, `.ndjson`, `.jsonl`, also with a compression suffix such as `.csv.gz`; CSV otherwise, as COPY decides), and the options given before and after the cursor (`copy`).

## Completion

- **Order.** Lambda parameters, columns of the first table, columns of the next, aliases, macros, functions, common keywords, other keywords. After FROM: CTEs, schemas (and the lake), tables of `main` unqualified, tables of other schemas as `schema.table`, table macros, table functions. After `alias.` only that table's columns (and struct fields after `alias.column.`); after `schema.` its tables, views and macros; after `lake.` the schemas and the functions of the lake. After CALL: the lake, then the procedures of DuckLake.
- **A column that two tables have** is offered with its qualifier (`o.id`, `p.id`); a subquery without alias has none, so such a column of it is left out.
- **Quoting.** A name is inserted quoted exactly when it needs it: it is not a plain word (`[A-Za-z_][A-Za-z0-9_]*`) or DuckDB lists it as anything but an unreserved keyword (`order`, `select`, `int`, ...). Quotes inside a name are doubled. If the word under the cursor is already quoted, everything is inserted quoted, a table of another schema as `"schema"."table"`, and the filter text is the inserted text, because VS Code filters by the typed text from the opening quote on.
- **Details.** A column shows its type and `NOT NULL` (a column of a view the DuckDB type, e.g. `DECIMAL(10,2)`); a table its row count in data files; a function its first signature.
- **Views.** Their columns come once the connection's views are trusted; until then one hint item says why a view offers none ([Columns of views](#columns-of-views)).
- **Functions** come from `duckdb_functions()`, grouped by name with their overloads. Scalar macros of `main` complete like functions, table macros after FROM.
- **Functions of DuckLake** are not in that list: the service loads no extension. The global ones (`ducklake_snapshots`, `ducklake_list_files`, `ducklake_expire_snapshots`, ...) come from `src/sql/ducklake-vocabulary.ts`, which `scripts/ducklake-vocabulary.mjs` generates ([below](#the-vocabulary-of-ducklake)); `src/sql/ducklake.ts` adds a description and an example to each and says which change the lake (procedures). The reading ones are offered after FROM, the procedures after CALL, both inserted with the lake's name as their first argument and placeholders for the other positional ones: `ducklake_table_changes('lake', '${1:schema_name}', '${2:table_name}', ${3:start_snapshot}, ${4:end_snapshot})`. The functions behind the lake's name (`lake.snapshots()`, `lake.table_changes()`, the procedures `lake.set_option()`, `lake.set_commit_message()`, `lake.merge_adjacent_files()`) are listed by hand in the same file, because DuckDB lists them for no catalog.
- **Named arguments.** Inside the call of a function of DuckLake or of a table function of DuckDB (`read_csv`, `read_parquet`, `read_json`, ...), once its positional arguments are typed, the named ones that are not given yet are offered as `dry_run => `; `header = true`, `header := true` and `header => true` count as given. DuckDB's names come from `duckdb_functions()` ([below](#the-vocabulary-of-duckdb)).
- **Options of COPY.** In `COPY ... TO 'file' (`: the options of the format first, then those of every format, without the ones given; after FORMAT the formats `csv`, `parquet` and `json`; in `PARTITION_BY (` and `FORCE_QUOTE (` the columns of the table that is copied. The names are in `src/sql/duckdb.ts`.
- **Window frames.** Inside `OVER (` first PARTITION BY, ORDER BY, ROWS, RANGE and GROUPS; in the frame the words that may come next: BETWEEN, UNBOUNDED PRECEDING and CURRENT ROW after ROWS, PRECEDING and FOLLOWING after an offset, AND after the first bound of BETWEEN, UNBOUNDED FOLLOWING after AND, the EXCLUDE forms after the frame.
- **Other DuckDB statements.** A FROM-first query goes on with SELECT before the other clauses. PIVOT offers ON, USING and GROUP BY after its table, UNPIVOT NAME and VALUE after INTO. After DESCRIBE and SUMMARIZE the tables come first, then SELECT, FROM and WITH for a query; after EXPLAIN (and EXPLAIN ANALYZE) the statement keywords.
- **Snippets.** At the start of a statement: `CHECKPOINT lake`, `COMMENT ON TABLE … IS '…'`, `ALTER TABLE … SET PARTITIONED BY (…)`, `ALTER TABLE … SET SORTED BY (…)` and the maintenance calls (`ducklake_merge_adjacent_files`, `ducklake_rewrite_data_files`, `ducklake_flush_inlined_data`, and `ducklake_expire_snapshots`, `ducklake_cleanup_old_files`, `ducklake_delete_orphaned_files` as dry runs). After a table in FROM: `AT (VERSION => …)` and `AT (TIMESTAMP => '…')`. After `ALTER TABLE t`: `SET PARTITIONED BY (…)` and `SET SORTED BY (…)`. Not inside parentheses, after UNION or after WITH.
- `sql_auto_complete` of DuckDB is not used: it works at the end of the text only, does not complete after `schema.`, knows no alias and gives no signatures.

## Hover and signature help

Hover first looks at the word: one followed by `(` is a function (a macro, a function of the lake behind `lake.`, a global function of DuckLake, or one of DuckDB). Otherwise the dotted name (`alias.column`, `schema.table.column.field`, a table, view, schema, the lake) is resolved against the relations of the query and the catalog; in a table position a table wins, elsewhere a column. A column of a CTE or subquery shows the column of the catalog that it reads, or else its name; the alias of a CTE or subquery lists its columns. A table also shows its partition keys (with their transform, e.g. `ts` (`month`)) and sort keys at the snapshot. An unqualified name that could be a column of several tables says nothing, as do keywords, operators, strings, comments, unknown names and lambda parameters (also one that hides a column of the same name).

Signature help counts the commas at the level of the call (commas inside parentheses, brackets, braces and strings, and those between the parameters of a lambda, do not count; the innermost known call wins), and `name := value` or `name => value` moves the marker to that parameter. It picks the first overload that has the parameter and lists all overloads. A named parameter (of DuckLake or of a table function of DuckDB) shows as `dry_run => BOOLEAN` and never takes a positional argument, so `ducklake_merge_adjacent_files('lake', |` picks the overload with `table_name`.

## Columns of views

DuckLake stores only the SQL of a view. Its columns are known only by binding it, which runs that SQL with the rights of the extension host. So completion and hover offer them only for a connection whose views you trusted: the same trust as the explorer's `Columns` folder ([Security](security.md#reading-data-tables-and-views)).

- **Trusted.** The first request that needs a view's columns (a view in the query, `v.`, a hover) starts the read in the background and answers without them; no request waits for the engine. A completion list that lacks them is marked incomplete (`pending` of the result, `CompletionList.isIncomplete`), so VS Code asks again at the next keystroke, and when the read ends the suggestions open again by themselves while the text and the cursor are those of the request. From then on the columns are offered like those of a table, with the DuckDB type as detail; hover shows type and nullability. Each view is read once per catalog and snapshot: the newest one, or the one that `AT (VERSION => n)` names. The read is the explorer's: `resolveViewColumns` (`src/data/resolve.ts`) and `describeRelation` (`src/data/engine.ts`) in a private DuckDB with the view guard, which refuses a view that calls a maintenance function of DuckLake ([Data access](data-access.md#views-and-trust)).
- **Not trusted.** Nothing is bound and nothing asks. After the columns of the tables, one item of the kind `hint` says why the view offers none and how to trust the connection's views: expand the `Columns` folder of a view in the explorer, or run **Select Top 1000 Rows** on a view. Accepting the item keeps the typed word. The trust is checked at every request, so trusting or revoking counts from the next one.
- **Failed.** A view that cannot be bound (a missing table, refused by the view guard, the time limit) offers no columns at that snapshot, and the failure is logged once as a warning to the "aantje" output channel. The next reload of the explorer (Refresh, a commit in the SQL editor) makes a new catalog, which reads it again.
- **No dialog while typing.** `trustedViewColumns` (`src/sql/editor.ts`) checks the trust (`ViewTrustStore.isTrusted`) instead of asking, and `src/extension.ts` gives it a data access that gets Microsoft tokens silently (no sign-in prompt; without a session the read fails). When `catalogCache` drops a catalog (the explorer reloads or changes its snapshot, the extension stops), it aborts the catalog's reads.

## Syntax errors while typing

`diagnose(text, source)` runs `json_serialize_sql(text)` (`serializeSql` and `syntaxErrorsOf` of `session.ts`), which only parses and never executes. "Only SELECT statements can be serialized" means another kind of statement is valid and counts as no error; empty text has none. Only the first error is reported. One text is parsed at a time; a call replaced by a newer one with the same `source` answers `undefined`, so a fast typist costs one parse, not one per keystroke. A text longer than 200 000 characters gets no marks. Only a SQL document with a connection is checked: a keystroke elsewhere starts no timer. The same parse gives the warnings for unknown names (below).

## Unknown names

With the catalog of the document's connection, the parse tree of the syntax check is checked against the lake (`parseText`, `src/sql/parse.ts`; `unknownNames`, `src/sql/unknown-names.ts`). Nothing is parsed a second time per keystroke and nothing runs. A false warning is worse than a missing one: what the text and the catalog do not settle gives none.

- **What is read.** `json_serialize_sql` serializes queries only (SELECT, FROM-first, VALUES, TABLE, DESCRIBE, SUMMARIZE). A text with other statements answers "Only SELECT statements can be serialized"; its statements are then split at the terminators and each query is parsed alone. The tables and views come from the reference extraction of the Dependencies report (`statementReferences`, `src/dependencies/references.ts`, which leaves out the CTEs). The column references come with what they can read (`columnUses`, `src/sql/tree-scope.ts`): the relations of FROM and JOIN with their aliases; CTEs, subqueries and VALUES with the columns that their select lists give; the aliases of the select list; and the queries around a subquery (correlated and LATERAL).
- **What is warned.** A table or view that its schema of the lake does not have, at the snapshot that the table names with `AT (VERSION => n)`, else the newest one: `t` (in `main`), `schema.t`, `lake.t` or `lake.schema.t`. A column `c` that no relation of the query or of the queries around it has, when the columns of all of them are known. A column `q.c` that the relation `q` lacks, when no relation has a column `q` (then `q.c` is a field of it).
- **Never warned, because the name may exist after all.** CTEs, aliases and lambda parameters. Table functions, PIVOT, files (`'orders.parquet'`), other catalogs (`other.t`, `memory`, `temp`, `system`) and a schema that the lake does not have (`x.t` may be the table t of a catalog x). DuckDB's own views (`duckdb_tables`, `pg_tables`, `information_schema.tables`, any `duckdb_`, `pragma_`, `sqlite_` or `pg_` name). A name that a statement other than a query in the same document names (what `CREATE TABLE`, `CREATE TEMP TABLE`, `ALTER TABLE` or `INSERT` creates or changes), and every name not written as `lake.schema.name` once the document has `USE`, `ATTACH`, `DETACH` or `SET search_path`. The columns of a relation whose columns are not all known: a view whose columns are not read ([Columns of views](#columns-of-views)), a subquery with an expression without alias, `COLUMNS(...)`, a star over a join with a shared column, the result of PIVOT or of `UNION BY NAME`, a recursive CTE. Struct fields (`t.s.f`, `s.f`) and `schema.table.column`. The columns that every table of DuckLake has (`rowid`, `filename`, `file_row_number`, `file_index`, `snapshot_id`) and the names that DuckDB reads as functions (`current_date`, `current_user`, `user`, ...). The ORDER BY of a set operation, and a table with `AT (TIMESTAMP => ...)` or another clause without a plain version.
- **No catalog, no warnings.** Without a catalog (not connected, still connecting) only the syntax is checked; so is a text with a syntax error. A catalog whose schemas or objects cannot be read gives no warnings; one whose first read takes more than a second gives none for that check, and its read goes on for the next one.
- **The quick fix** (`quickFixes`, `src/sql/problems.ts`, offered by the code action provider of `language.vscode.ts`) replaces the name with one of the nearest known names (`nearestNames`): by edit distance ignoring case, a swap of two neighbours counting one; at most three, none that differs in more than a third of its letters (one for a name of two to five letters), so a name with nothing close gets none. A table is offered the tables and views of its schema, `q.c` the columns of q, `c` the columns of the innermost query, where a column that two relations have comes as `o.id` and `p.id`. A name is inserted quoted when it needs it or the misspelt one was quoted. The fixes belong to the version of the text that was checked: after an edit they wait for the next check.

## Snapshots and time travel

The catalog is the newest snapshot, as the SQL session sees it. A statement with `AT (VERSION => n)` is completed, explained and helped with the objects of snapshot n (`statementSnapshot`, `src/sql/context.ts`, and `at` of the port). Inside `AT (` the clause offers `VERSION =>` and `TIMESTAMP =>`; after `VERSION =>` (or in its number) the snapshots (newest first, at most 200) with time and changes, after `TIMESTAMP =>` the snapshot times as literals. Inside the quotes of the timestamp only the time is inserted, and the closing quote when it is missing; typing `'` opens the list there. DuckLake takes the last snapshot at or before the time, so the literal is one millisecond later than shown.

## The vocabulary of DuckDB

`loadVocabulary` reads DuckDB's functions with their parameters from `duckdb_functions()` of the service's DuckDB. For a table function that list holds the positional parameters and then the named ones (`read_csv`: `path`, then `header`, `delim`, ...) without saying where the named ones start. `src/sql/duckdb-vocabulary.ts` says it: the number of positional parameters of each table function that also takes named ones. `node scripts/duckdb-vocabulary.mjs` writes it from a throw-away in-memory DuckDB of the shipped `@duckdb/node-api` without extensions and with external access off, as the service's, with the binder technique of the [DuckLake vocabulary](#the-vocabulary-of-ducklake) (`EXPLAIN FROM f(NULL, ...)`: bound, nothing read or run). The service itself binds nothing: binding every table function would add about 160 ms to its start. The names stay those of the running DuckDB, so a new named option appears without a new file; a table function that binds to no number of NULL arguments (the variadic `repeat_row`) keeps all its parameters positional, and one whose overloads differ in their positional count makes the script fail.

DuckDB lists the options of COPY nowhere. `src/sql/duckdb.ts` names them by format, as the DuckDB documentation describes them.

`test/unit/sql-duckdb-vocabulary.test.ts` generates `duckdb-vocabulary.ts` again in memory and fails when it differs from the checked-in one: run the script and commit the file. It also binds `EXPLAIN COPY (SELECT 1 AS a) TO 'out.<format>' (FORMAT <format>, <option>)` for every option of `duckdb.ts` with external access off (no file is written) and fails when DuckDB does not know a name for its format.

## The vocabulary of DuckLake

`npm run vocabulary:ducklake` (`scripts/ducklake-vocabulary.mjs`) loads the `ducklake` extension from `test/.cache/duckdb-extensions` (or the directory given as argument) into a throw-away in-memory DuckDB of the shipped `@duckdb/node-api`, reads the `ducklake_*` rows of `duckdb_functions()` and writes `src/sql/ducklake-vocabulary.ts`, formatted by Prettier: per function its kind and overloads, each with its positional and its named parameters. `duckdb_functions()` lists both kinds of parameters in one list; the script tells them apart with the binder: the longest list of leading arguments that binds (`EXPLAIN FROM f(NULL::type, ...)`, nothing attached, nothing run) is the positional one.

`test/unit/sql-ducklake-vocabulary.test.ts` generates the file again in memory and fails when it differs from the checked-in one, so a new DuckDB or DuckLake build shows up as a failing test: run the script and commit the file. The same test fails when a function has no text in `src/sql/ducklake.ts`, or a text no function; `ducklake_scan` and `ducklake_commit` are left out on purpose: the first refuses a direct call, the second takes no lake and is not among the functions that the DuckLake documentation describes.

## Performance and security

Completion, hover and signature help tokenize only what changed (`tokenWindow`, `src/sql/token-window.ts`). DuckDB's lexer starts anew after every terminator, so the tokens of the last four texts are kept, and a new text is read again from the last terminator before its first change, up to the end of the statement at the cursor; a request for a text that is known needs no DuckDB at all. On a lake of 1 000 tables and 20 000 columns, completion while typing at the end of a script of 50 000 characters takes 2 to 5 ms instead of the 75 ms of tokenizing the whole text (about 1.5 ms per KB); the catalog part (the lookups of the port's cache and the items) takes 1 to 4 ms of that. A statement of 50 000 characters is still read whole. Texts longer than 500 000 characters get no completion, hover or signature help. The DuckDB and the vocabulary are created on the first call (about 130 ms) and kept.

The service only tokenizes and parses, never runs the text. Its DuckDB is separate from the SQL session and the lake and has external access off. The syntax check needs no credentials and never connects to the lake.

The one thing that runs SQL is the binding of a view for its columns: the SQL stored in the catalog, never text of the editor, and only after you trusted the connection's views ([Columns of views](#columns-of-views)). It runs in the private DuckDB of the data engine, read-only and with the view guard, as for the explorer, and binds the view without reading rows.

## Limits

- Unknown names are found in queries only: the queries inside INSERT, CREATE TABLE ... AS, COPY or EXPLAIN are not checked. Types and ambiguity are reported when the statement runs.
- The warnings assume the session as it starts: the lake is the current catalog and `main` its schema. A temporary table, an attached database or a `USE` of an earlier run that the document no longer holds is not known, nor an object that another client created after the explorer last read the lake (Refresh reads it again).
- The columns of CTEs, subqueries and VALUES come from their text and are best effort (no wrong ones are offered): an expression is offered only under its alias, a table function only with column aliases (`range(3) r(i)`), the result of PIVOT never. A `FROM (a JOIN b)` group and `LATERAL` are not understood.
- The columns of a view are offered only after the connection's views are trusted, and only once the read has ended: the list opens again by itself then, unless you typed or moved the cursor meanwhile, in which case the next keystroke or **Trigger Suggest** (Ctrl+Space) brings them. The fields of a struct column of a view are not offered.
- The first `AT (VERSION => n)` of a statement decides the snapshot of the whole statement, also for its other tables; `AT (TIMESTAMP => ...)` does not change it.
- Completion inside a string is offered only for the time of `AT (TIMESTAMP => '...')`, not for file names or the patterns of `COLUMNS('...')`.
- The values of the IN list of PIVOT and the columns of the result of PIVOT or UNPIVOT are not known: they would need a query.
- The arrow form of a lambda (`x -> x + 1`) is not read as one: DuckDB 2.0 refuses it by default, and `->` is also the JSON operator. A lambda parameter is offered besides, not instead of, a column of the same name.
- The options of `COPY ... FROM` and the values of an option other than FORMAT are not offered; a qualified column in `* EXCLUDE (t.c)` is not completed.

## Testing

```bash
npx vitest run test/unit/sql-context.test.ts test/unit/sql-position.test.ts test/unit/sql-completion.test.ts
npx vitest run test/unit/sql-help.test.ts test/unit/sql-language.test.ts test/unit/sql-catalog.test.ts
npx vitest run test/unit/sql-performance.test.ts test/unit/sql-ducklake-vocabulary.test.ts test/unit/sql-duckdb-vocabulary.test.ts
npx vitest run test/unit/sql-view-columns.test.ts test/unit/sql-names.test.ts test/unit/sql-token-window.test.ts
```

The context tests are tables over clauses, positions and the select lists of CTEs and subqueries on the real tokenizer's tokens, the position tests over frames; the completion and help tests use the real `CatalogReader` on the fixtures and state exact lists; the language tests cover the syntax errors, that no text is ever run, and (against a real lake) that inserted names with hostile characters run, and that the example of every function of DuckLake and every statement snippet of a maintenance call runs. The name tests are tables of statements with the warned names marked and the names their quick fixes offer, and of statements that must get no warning, on the fixtures; every warned statement fails when it runs on a lake with data and runs once its first fix is in, a list of statements of DuckDB's own SQL runs without a warning, and on the lake of hostile names each fixed statement runs. The token window test compares the tokens after edits (a quote or comment that opens to the end of the text, a change at the start) with DuckDB's tokens of the whole text and counts what was read. The performance test measures completion on a made-up lake of 1 000 tables and 20 000 columns while typing at the end of a script of 50 000 characters: after a warm-up that reads the catalog, the median of 15 keystrokes stays under 50 ms. The view column tests drive `trustedViewColumns` with a fake trust and a fake engine behind `resolveViewColumns` (trusted, not trusted, a failed and an aborted read, the list that lacks columns while the read runs), and bind a view of a real lake at the newest snapshot and at an older one. The lake tests need the DuckDB extensions in `test/.cache/duckdb-extensions` ([Testing](testing.md)) and are skipped with a reason without them.
