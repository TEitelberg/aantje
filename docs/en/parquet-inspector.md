# Parquet inspector

The Parquet inspector looks into the footer of a Parquet file: its row groups, the encodings and compression of its columns and the statistics of each column in each row group. It shows why a scan reads too much (row groups whose ranges overlap, so that a filter skips none) and checks the effect of a rewrite or a sort order. It reads only the footer, never the rows.

## Opening it

| Command                                                | On                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **Inspect Data Files...** (`aantje.inspectDataFiles`)  | the Reports submenu of a table, and the selected table of the [Storage report](storage-report.md) |
| **Inspect Parquet File** (`aantje.inspectParquetFile`) | a `.parquet` file in the [Files](files.md) folder (context value `file.importable.parquet`)       |

Both commands need a node and are hidden from the Command Palette.

- **Inspect Data Files...** reads the data files of the table at the snapshot the tree shows from the catalog (`fileLocations`, at most 100,000) and offers them in a pick of one file: the 10 largest, the 10 newest and the 10 smallest, each file once, with its size, rows and the snapshot that wrote it. A table whose rows are all inlined in the catalog has no data file and says so. The same pick comes from the Storage report.
- **The drop-down Data file** at the top of the panel offers the files of that pick, in the same groups, by name with size, rows and the snapshot that wrote it. Choosing another reads its footer and shows it in the same panel, with its name in the title; the column chosen for the row groups stays when the other file has it. The data file of an encrypted lake shows the figures of the catalog, as when it is picked.
- **Inspect Parquet File** opens the panel of a file of the storage that is not one of the lake's data files. It has no table, so its panel has no drop-down.
- **One panel per connection and table** (Inspect Data Files...) **or per connection and file** (Inspect Parquet File), titled `Parquet Inspector: <file name> · <connection>` (the name of the file, not its path; the page heading is `Parquet Inspector: <file name>`). Picking a file of the table again shows it in the panel of the table, with a fresh read. **Refresh** reads the footer again.

The Statistics report lists no single file, so it has no entry of its own; the Storage report has **Inspect Data Files** in the selection of a table.

## What the panel shows

- **The file:** the path, for a data file of the lake its id, its table and the snapshot that wrote it. Key figures: size, rows (with the count of the catalog when it differs, a warning), row groups, columns, the writer (`created_by`), the Parquet version and the encryption of the footer.
- **Row groups:** one row each with rows, compressed and uncompressed bytes and, for the column chosen above the table, minimum, maximum, null count and distinct count where the writer recorded them. A bar shows where the range of each row group lies among all values of the column (an ordinal scale: numbers as numbers, dates and text as text). Below the table, how many pairs of row groups overlap: from half of them on, a filter on the column skips few row groups, which a sort order on the column would change.
- **Columns:** each leaf column with its physical and logical type, compressions and encodings over its chunks, whether it has a dictionary page and a bloom filter, the field id and the DuckLake column it maps to (DuckLake writes the column id as field id; a column the table no longer has is named so), and its compressed and uncompressed bytes.
- **Key/value metadata** of the footer: at most 50 entries, values cut at 500 characters.
- **Probe** on a column with a bloom filter asks for a value in an input box, then asks the bloom filters (`parquet_bloom_probe`) of every row group: the panel lists the row groups whose filter excludes the value. A filter can only exclude; a row group that is not excluded may hold the value or not.

A file with many row groups lists the first ones, so that the statistics of all columns stay below 20,000 cells (at most 1,000 row groups); the panel says how many there are.

**Open as Markdown** and **Copy** write the same document: the figures, the row groups of the chosen column (at most 200), the columns and the key/value metadata. Copy puts it on the clipboard. Every value from the file is code in the document and text on the page.

## Data and safety

DuckDB reads the footer with `parquet_file_metadata`, `parquet_schema`, `parquet_metadata`, `parquet_kv_metadata` and, for a probe, `parquet_bloom_probe` (`src/parquet/read.ts`), on a session of the lake with the storage sign-in of the connection, the one the deep check of the [Health check](health-check.md) uses (`withLakeSession`): read-only, configuration locked. A footer is two small ranged reads on an object store.

- **Encrypted lakes:** a data file with an encryption key in the catalog is not opened; the panel shows the figures of the catalog and says that the lake is encrypted.
- **Only below the data path:** a catalog can name any path or URL. A data file whose path does not lie below the data path of the lake is not opened (`isBelowDataPath`, as the health check), and the panel says so. A file of the Files folder lies below a root that the connection lists.
- **Statements:** the path is a literal with doubled quotes and escaped glob characters, so it names exactly that file; the value of a probe is a literal too.
- **The page asks, the extension decides:** the page sends `bloomProbe` or `copy` with the index of a column, or `openFile` with the id of a data file, and nothing else (`isParquetAction`); the value of a probe is asked by the extension in its own input box, a probe runs only for a column of the data that has a bloom filter, and another file opens only when it is one of the files that the extension listed for the table, with the facts the catalog gave for it (`planParquetAction`). The checks above apply to it as to a picked file.

## Module

`src/parquet/`: `model.ts` (the data, the pick groups and the files of the drop-down, the ranges and their overlap, the key figures), `read.ts` (the files of a table, the footer read, the probe), `actions.ts`, `protocol.ts`, `kind.ts`, `markdown.ts`, `page.ts`, `style.ts`, `commands.vscode.ts`.

## Known limits

- Statistics are what the writer recorded: DuckDB writes minimum, maximum and null count; the distinct count only when known.
- Deletion vectors (Puffin) and files that are not Parquet are not offered.
- The SQL editor's performance tips and the Maintenance Advisor do not link to the inspector yet.
