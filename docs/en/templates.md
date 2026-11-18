# Templates

A template is a SQL statement or script with blanks to fill in, kept so that you start from a tested statement instead of from memory or an old file: a partitioned table from Parquet files, a `MERGE` upsert, the rows that changed between two snapshots, maintenance. aantje ships DuckLake templates, keeps your own and imported ones, and lists the templates of folders that you name. The page searches them, shows the ones you use most and last, lists them all in **Browse**, and **Use** opens a template filled in as a new SQL document of a connection. Nothing runs until you run it.

The code is in `src/templates/` (see [Architecture](architecture.md#templates-the-sql-templates)).

## Opening the page

- **Templates** in the `...` menu (More Actions) of the view title of the aantje catalogs, or **aantje: Templates** in the Command Palette (`aantje.openTemplates`).
- The page is one editor tab. A second call brings it forward and reads the templates again.

## The page

- **The logo of aantje** at the top, and below it, with some space, **a search field** in the manner of a search engine start page: one line, focused when the page opens, results while you type. It finds a template by every word you type, in its name, tags, description and SQL text, case ignored, and by its source (`built-in`, `mine`, `imported`, `folder`). A word in the name counts most, then a tag, the description, the rest; equal matches by use, then by name. At most 60 tiles are shown; another word narrows the search. Escape in the field or deleting the text goes back to the rows.
- **The tiles** of the templates have one width and stand four in a row, in a block in the middle of the page; a row with fewer tiles starts at the left of the block, below its heading. A window too narrow for four has three, two or one tile in a row.
- **Before anything is typed** the page shows **Most used** and **Recently used**, a row of four tiles each (the templates used most often and the ones used last), and below them **Recently created**, a list of the ten templates created last, newest first and equal times by name, with the columns and the icon buttons of [Browse](#browse) but without its filters and pages. It mixes all sources: your own and imported templates by the time they were kept first, built-in and folder templates by the day of their [`created` field](#template-format); a template without a time of creation is left out. Like Browse, the list is as wide as the tiles and never scrolls sideways, with fewer columns in a narrower window. An empty block is left out. Before any template was used, the first four built-in templates are shown as a start.
- **Tiles** and **Browse**, **Import...** and **Download example** below the search field: **Browse** lists all templates instead of the tiles ([Browse](#browse)), **Tiles** goes back.
- A note above the tiles names a folder of `aantje.templates.folders` or a file in it that could not be read or was refused.

A tile shows the name, the source (built-in, mine, imported or folder), the description, the tags, and how often and when the template was last used. A tile of a folder shows its file on hover. Its actions:

| Action        | Templates                     | What it does                                                                               |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| **Use**       | all                           | Opens the template filled in, as a new SQL document of a connection (below). Nothing runs. |
| **Duplicate** | built-in and folder templates | Keeps a copy as one of your own templates and opens it in an editor to change.             |
| **Edit**      | own and imported templates    | Opens its text in an editor; saving the editor keeps the change (below).                   |
| **Export...** | own and imported templates    | Saves its text as a `.sql` file where you choose.                                          |
| **Delete**    | own and imported templates    | Deletes it, with its use, after a question. An open editor of it can no longer save it.    |

The page gets every template with its text when it opens, so that the search runs in the page. It names an action and the id of a template that it was sent; the extension checks both against what it sent and against the source of the template (`src/templates/protocol.ts`), as the reports do ([Reports](reports.md#host-side)).

## Browse

**Browse** shows every template, built-in, own, imported and of the folders, in one list sorted by name instead of the tiles, 25 to a page; the search field stays above it:

| Column          | What it shows                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**        | The name; a click marks the row.                                                                                                                                                               |
| **Description** | Its first two lines; the whole of it on hover.                                                                                                                                                 |
| **Tags**        | The tags.                                                                                                                                                                                      |
| **Source**      | built-in, mine, imported or folder; a folder template shows its file on hover.                                                                                                                 |
| **Actions**     | The actions of its tile as small icon buttons, each named on hover and for a screen reader: **Use**, and **Edit**, **Export...** and **Delete** or **Duplicate**. A button also marks its row. |

The search field of the page finds templates in the list as it finds tiles (every word in the name, the tags, the description or the SQL), and a new search starts on the first page. Above the list: **Tag** and **Source**, all or one; and the pages, **First**, **Previous**, **Next** and **Last** with the page and the count between them. A change of the box, the tag or the source goes back to the first page. The list is the paged table of the shell (`src/shell/paged-table.ts`). **Tiles** goes back to the search and the tiles.

The list is as wide as the tiles and never scrolls sideways: its columns have fixed widths, and the description takes what is left. With two tiles in a row it leaves out Source, with one also Tags and Description. A long name wraps; a description longer than two lines, a source or a tag that does not fit is cut with an ellipsis and shown whole on hover. In a narrow window the filters and the pages wrap onto more lines above the list.

The page keeps the view, the search, the tag, the source, the page and the marked template while VS Code hides it; new data (a use, an import, a save) keeps them too.

## Use

1. **The connection.** The new document belongs to the connection of the editor that had the focus last (the page takes the focus from it), when that is a SQL editor of a connection. Otherwise aantje asks as **New Query** does: a single connection is taken, several are offered in a picker.
2. **The names.** The `{{name}}` placeholders of the template are asked for in the dialog of the SQL editor ([Parameters](sql-editor.md#parameters)): one input box per parameter, with its type, description and the last value given for this template in this window, else its default. Escape cancels, and nothing opens.
3. **The document.** aantje replaces each `{{name}}` by the SQL text of its value (an `identifier` as a quoted name, a `text` as a quoted literal, a `number` checked, a `date` as `DATE '...'`) and opens the text in a new SQL document of the connection. It starts with the name and the description of the template as comments. The other comment lines of the header stay, the template fields go, and of the `-- param:` lines only those of the `$name` placeholders stay. A `{{name}}` that **Use** asks for also goes into the comments after the header, so that a statement that the template keeps commented out, such as the real step under a dry run, names the same tables once you remove its `-- `; a value that holds a line break or `*/`, which would end that comment, is refused.
4. **The values.** A `$name` placeholder stays in the text: **Run Query** asks for its value and binds it, as for any script with parameters, with the type, default and description of its `-- param:` line.

The use is counted only when the document opened. A template is filled in, never run: you read the SQL and run it yourself.

## Own templates

- Your own templates come from **Save Selection as Template...** (below), **Duplicate** of a built-in or folder template, and **Import...**. The page has no button for an empty template: start from a selection, a copy or the example of **Download example**.
- **Duplicate** keeps the text of a built-in or folder template as a new template of yours, with the day of the copy as its `created` field in place of the day of the original (or after the other fields when the original has none).
- **Edit** and **Duplicate** open the text of a template in an editor of its own (`aantje-template:/<id>/<name>.sql`). Saving it keeps the text, after the checks below: a template that aantje refuses is not saved, VS Code says why, and the editor keeps your change. An imported template that you save is one of your own from then on. The editor has the colours of SQL but no IntelliSense of aantje: a template has no connection.
- **Save Selection as Template...** in the context menu and the `...` menu of a SQL editor of a connection (also **aantje: Save Selection as Template...** in the Command Palette of a SQL editor) keeps the selected SQL, or the whole document when nothing is selected, as one of your templates. It asks for the name, a description and tags, and writes them with the day of the save as `created` into the header. The template gets a `-- param:` line for every placeholder of the selection: the line of the document's header where it declares the parameter, else a plain `-- param: name` (a `text`). A message offers to open the page or the template.
- **Delete** asks first; there is no way back. **Export...** saves the text as it is kept, its `created` field included, so that a folder of templates or another machine gets the day it was created.

## Import and Download example

- **Import...** asks for one or more `.sql` template files or `.json` bundles. aantje reads them as text and runs nothing. Each template goes through the checks below; the refused ones are named in a warning and listed in the output channel. An imported template replaces an imported one of the same name that you did not change (it keeps its use), so that you can import a newer version of a team's templates again; otherwise it is added. A `.sql` file of more than 64 KB, a bundle of more than 8 MB or 500 templates, and a file that is no template are refused.
- **Download example** saves an example template where you choose and opens it: every field of the header filled in and explained in its comments, both kinds of placeholders, and the format of a bundle. It is a valid template; import it to try.

## Template format

A template is a `.sql` file. The comment lines at its start, its header, name it and declare its parameters, so a template is also a valid SQL file that can live in Git:

```sql
-- aantje-template: 1
-- name: Partitioned table from Parquet files
-- description: Creates a table from Parquet files, partitioned by year and month before the rows go in.
-- tags: load, partitioning
-- created: 2026-11-16
-- param: schema    | identifier | main                       | Target schema
-- param: table     | identifier |                            | New table
-- param: files     | text       | s3://bucket/path/*.parquet | Source files
-- param: ts_column | identifier | ts                         | Timestamp column to partition by
CREATE TABLE {{schema}}.{{table}} AS SELECT * FROM read_parquet({{files}}) LIMIT 0;
ALTER TABLE {{schema}}.{{table}} SET PARTITIONED BY (year({{ts_column}}), month({{ts_column}}));
INSERT INTO {{schema}}.{{table}} SELECT * FROM read_parquet({{files}});
```

- **The header** is the comment lines and blank lines at the start; the SQL starts at the first other line. A field is a line `-- field: value`, the field name in any case:

| Field             | Required | Value                                                                                          |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `aantje-template` | yes      | The format, `1`. A `.sql` file without this line is no template.                               |
| `name`            | yes      | The name on the card.                                                                          |
| `description`     | no       | One line on what the template does.                                                            |
| `tags`            | no       | Words to find it by, separated by commas; each counts once.                                    |
| `created`         | no       | The day the template was created, `YYYY-MM-DD`, a real day (below).                            |
| `param`           | no       | One line per parameter, `name \| type \| default \| description`: the lines of the SQL editor. |

A field given twice is refused, and so is a `created` that is no real day in the form `YYYY-MM-DD`. **`created`** puts built-in and folder templates into **Recently created**, at the start of that day in UTC, and the Created column shows the day; aantje writes it into the templates it makes (**Save Selection as Template...**, **Duplicate**). An own or imported template has the time aantje kept it first instead, also when its field names another day (an imported one keeps the day of its author in its text) or is changed later; the field counts only for a template kept before aantje kept that time. Other comment lines in the header stay comments. White space in a value collapses to one space, and invisible characters (control characters, bidi overrides) are dropped.

- **Parameters and placeholders** are those of the SQL editor ([Parameters](sql-editor.md#parameters)), read by the same code (`src/sql/parameters.ts`): the types `text` (the default), `number`, `date` (`YYYY-MM-DD`) and `identifier`; `{{name}}` is filled in by **Use**, `$name` stays for the run and is bound there, never pasted into the SQL. A placeholder in a comment, a string or a quoted name is none (but **Use** fills a `{{name}}` that it asks for into the comments after the header, see [Use](#use)); one that the header does not declare is a `text` without a default. Put names (schemas, tables, columns, paths) into `{{name}}` and values that change from run to run (a snapshot id, an age, a day) into `$name`.

### A bundle of templates

Several templates can be one `.json` file for **Import...**, each with its whole text:

```json
{
  "aantje-templates": 1,
  "templates": [{ "text": "-- aantje-template: 1\n-- name: First\nSELECT 1;" }, { "text": "..." }]
}
```

## Built-in templates

They ship in the VSIX (the files of `src/templates/builtin/`, bundled into the extension as text) and follow the DuckDB and DuckLake version of aantje. Each names the day it was written in its `created` field (`2026-11-16` for the DuckLake templates, the day the template store was built; `2026-11-17` for the generic ones), so that they take part in **Recently created**. A unit test (`templates-builtin.test.ts`) uses every one of them with sample values on a DuckLake in a DuckDB file and runs it, the `$name` values bound, so that none ships with an error; for the generic ones it also checks what the run finds in its sample tables, and it runs the real step of **Remove duplicates, keep newest** and checks that the table keeps its id and settings. Like the [Maintenance scripts](maintenance.md), the DuckLake templates name the lake `lake`, as the SQL editor attaches it.

| Template                                | What it does                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partitioned table from Parquet files    | `CREATE TABLE ... AS ... LIMIT 0`, `SET PARTITIONED BY (year(...), month(...))`, `SET SORTED BY`, then the `INSERT`, so every file has that layout.                        |
| Upsert rows with MERGE                  | `MERGE INTO` a table from a source with the same columns, matched by one column: update what exists, insert what is new.                                                   |
| Rows changed between two snapshots      | `ducklake_table_changes` of a table; the snapshot ids are `$name` values.                                                                                                  |
| A table at a snapshot                   | `SELECT ... AT (VERSION => $version)`.                                                                                                                                     |
| Expire snapshots and clean up old files | `ducklake_expire_snapshots` older than an age (`$older_than`), then `ducklake_cleanup_old_files`; both as dry runs, the real calls commented out under them.               |
| Restore a table to a snapshot           | `DELETE` and `INSERT ... AT (VERSION => $version)` in one transaction, so the table keeps its id; for a table whose columns changed, use **Restore Table to Snapshot...**. |
| A table at a point in time              | `SELECT ... AT (TIMESTAMP => ...)`; the time is filled in as a literal, because DuckLake does not take a bound value there.                                                |
| Add existing Parquet files to a table   | `ducklake_add_data_files`; the lake owns the files from then on.                                                                                                           |
| Change with a commit message            | `BEGIN`, `CALL lake.set_commit_message(author, message)`, your statements, `COMMIT`.                                                                                       |
| Flush inlined data of a table           | `ducklake_flush_inlined_data` with `schema_name` and `table_name`.                                                                                                         |

The first four are the start of the page before any use. Uncommenting a real call of the expire template keeps its `$older_than`, so the run asks for the age again, with the value of the dry run.

**Generic templates** are plain DuckDB SQL without a function of DuckLake, so they run on any table of any lake. The names of the schema, tables and columns are `{{name}}` parameters of the type `identifier`, one column each (a key of several columns needs the others added by hand, as the descriptions say); the values are `$name` placeholders with an inline default (`$limit{1000}`), asked for at every run. Nothing of them writes but the real step of **Remove duplicates, keep newest**, which stays commented out under its dry run.

| Template                         | What it does                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate keys                   | The values of a key column that more than one row has, with their number of rows, the most frequent first (`GROUP BY ... HAVING count(*) > 1`).                                                                                                                       |
| Remove duplicates, keep newest   | A dry run: how many rows would go and some of them, all but the row with the largest value of an order column of each key. Commented out under it, the delete of those rows: `DELETE FROM ... WHERE rowid IN (SELECT rowid ... QUALIFY row_number() OVER (...) > 1)`. |
| Orphaned rows                    | The rows of a child table whose key of a parent has no row in the parent table (`ANTI JOIN`); DuckLake has no foreign keys that would prevent them.                                                                                                                   |
| Compare two tables               | The rows that only one of two tables with the same columns has, with the side (`EXCEPT` both ways).                                                                                                                                                                   |
| Missing days in a date series    | The days between the first and the last day of a date or timestamp column without a row (`generate_series` and `ANTI JOIN`).                                                                                                                                          |
| Data freshness                   | The newest time of a column, its age in hours and `ok` or `stale` against a limit (`$hours{24}`); a timestamp without a time zone counts as UTC.                                                                                                                      |
| Top N per group                  | The rows with the largest values of a measure in each group (`QUALIFY row_number() OVER (PARTITION BY ... ORDER BY ... DESC) <= $n{5}`).                                                                                                                              |
| Running total and moving average | Per day the sum of a measure, the running total and the average over the last days (`$days{7}`, a `RANGE` of days).                                                                                                                                                   |
| Pivot a measure                  | `PIVOT ... ON category USING sum(measure) GROUP BY row`: one column per category.                                                                                                                                                                                     |
| Outliers by z-score              | The rows whose value lies more than `$z{3}` standard deviations from the mean, with their z-score.                                                                                                                                                                    |

The real step of **Remove duplicates, keep newest** deletes only the duplicate rows: the table keeps its id and its settings (`NOT NULL`, partitioning, sort order, comments), DuckLake records an ordinary snapshot with the deletions, and time travel to a snapshot before it reads the deleted rows. It finds the rows by `rowid`, the number that DuckDB gives each row of a table. A column of the table's own named `rowid` hides that number, and the step would delete other rows: do not run it on such a table.

## Storage

- **Own and imported templates** are kept in the global state of VS Code (the key `aantje.templates`): per user, for all workspaces, on this machine, not synchronised. Each holds its text, at most 64 KB, when it was kept first and when it was saved last; aantje keeps at most 500. A template that has no time of its first keeping yet counts from the `created` field of its header, else from its last save.
- **The use** of every template (how often, when last) is kept under `aantje.templateUses`, by the id of the template, and never leaves the machine. Deleting a template deletes its use.
- **The last values** of the dialog are kept per template while the window is open, like those of a SQL document.

## Folders of templates

The setting `aantje.templates.folders` (machine scope, default `[]`) names folders whose templates the page lists read-only, with the source _folder_: for example the clone of a Git repository that a team shares. aantje reads the `.sql` files directly in each folder (not in subfolders, at most 200 per folder) that are marked as a template with `-- aantje-template: 1`; other `.sql` files are passed over. A path must be absolute; `~` at its start is the home folder. The folders are read again each time the page opens, when the setting changes and when a template changes. A file that is larger than 64 KB, cannot be read or is refused by the checks below is left out with a note on the page. **Duplicate** makes an own template of one to change.

## Checks and safety

Every template that aantje keeps or lists passes the same checks (`checkTemplate`, `src/templates/model.ts`), on save, on import and when a folder is read:

- The header has the line `-- aantje-template: 1` and a name; no field is given twice; every `-- param:` line can be read; no `identifier` stands as a `$name` (a name cannot be bound); the text is at most 64 KB.
- **No secrets.** A template keeps no password, key or token. It is refused when a parameter named like a secret (its name contains `key`, `secret`, `token`, `password`, `credential` or `connection_string`, as the SQL editor types it hidden) has a default; when a header line holds a password of a connection string (`password=...`, `scheme://user:password@`); when the text holds the shape of an AWS access key, a private key, a JSON Web Token or the key or signature of Azure storage; and when a statement hands over a value where the Query History masks a secret (the options of `CREATE SECRET` other than `TYPE` and `PROVIDER`, a `SET` of a secret setting, a password in a connection string), unless that value is a placeholder: `CREATE SECRET (TYPE s3, KEY_ID {{key_id}}, SECRET $secret)` is fine. The detection is that of the Query History (`src/sql/history-mask.ts`, [Query History](sql-editor.md#query-history)). A message names the reason, never the value.

Besides:

- **Import reads text only.** Nothing of a template runs on import or on **Use**; **Use** opens the SQL in an editor, and you run it.
- **The page writes template text as text** (`textContent`): a name, tag or statement with markup shows the markup as characters. The page loads no remote resource; its content security policy allows the scripts of `dist` and the logo from `media` ([Reports](reports.md#host-side)).
- **The editor of a template** accepts a save only through the checks; it cannot delete, rename or create other files.

## Limits

- A template is filled in once, by **Use**. Changing a value later means changing the SQL or using the template again; the `$name` values are asked for at every run.
- `choice` lists of values are no parameter type: the types are those of the SQL editor.
- The folders are read, not watched: a change in a folder shows when the page reads the templates again.
- Saving a favourite of the Query History as a template is not part of this page yet.
- An editor of a template that was open when VS Code restarted may open before aantje is active and then cannot be read; open the template again from the page.
