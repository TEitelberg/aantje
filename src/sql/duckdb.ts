// What DuckDB does not list itself: the options of `COPY ... TO`, by format. `sql-duckdb-vocabulary.test.ts` checks
// that the shipped DuckDB accepts every name for its format.

/** The formats whose options are offered; without FORMAT the file name picks one (`formatOf`, `context-frames.ts`). */
export const COPY_FORMATS: readonly string[] = ['csv', 'parquet', 'json'];

/** The options of `COPY ... TO` for every format. */
export const COPY_TO_ANY_FORMAT: readonly string[] = [
  ...['format', 'partition_by', 'per_thread_output', 'file_size_bytes', 'overwrite', 'overwrite_or_ignore'],
  ...['append', 'filename_pattern', 'file_extension', 'use_tmp_file', 'preserve_order', 'return_files'],
  ...['write_partition_columns', 'write_empty_file', 'hive_file_pattern'],
];

/** The options of `COPY ... TO` of one format, as the DuckDB documentation describes them. */
export const COPY_TO_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  csv: [
    ...['header', 'delim', 'sep', 'quote', 'escape', 'nullstr', 'dateformat', 'timestampformat'],
    ...['force_quote', 'compression', 'prefix', 'suffix', 'new_line'],
  ],
  parquet: [
    ...['compression', 'compression_level', 'row_group_size', 'row_group_size_bytes', 'row_groups_per_file'],
    ...['parquet_version', 'field_ids', 'kv_metadata', 'dictionary_size_limit', 'write_bloom_filter'],
    ...['string_dictionary_page_size_limit', 'bloom_filter_false_positive_ratio', 'geoparquet_version'],
    ...['shredding', 'return_stats', 'encryption_config'],
  ],
  json: ['array', 'compression', 'dateformat', 'timestampformat'],
};
