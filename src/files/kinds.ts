// The files that the Files folder offers to import: the kinds DuckDB reads with a table function of its own, known by
// the end of the name (the letter case does not matter).

export type FileKind = 'csv' | 'parquet' | 'json' | 'xlsx';

/** The table function that reads a kind. */
export const READER: Readonly<Record<FileKind, string>> = {
  csv: 'read_csv',
  parquet: 'read_parquet',
  json: 'read_json',
  xlsx: 'read_xlsx',
};

/** What the kinds are called for the user. */
export const KIND_LABEL: Readonly<Record<FileKind, string>> = {
  csv: 'CSV',
  parquet: 'Parquet',
  json: 'JSON',
  xlsx: 'Excel',
};

// Longest first, so that `.csv.gz` wins over `.gz` (which is no kind).
const SUFFIXES: readonly (readonly [string, FileKind])[] = (
  [
    ['.csv', 'csv'],
    ['.tsv', 'csv'],
    ['.csv.gz', 'csv'],
    ['.tsv.gz', 'csv'],
    ['.csv.zst', 'csv'],
    ['.tsv.zst', 'csv'],
    ['.parquet', 'parquet'],
    ['.json', 'json'],
    ['.jsonl', 'json'],
    ['.ndjson', 'json'],
    ['.json.gz', 'json'],
    ['.jsonl.gz', 'json'],
    ['.ndjson.gz', 'json'],
    ['.xlsx', 'xlsx'],
  ] as const
).toSorted(([a], [b]) => b.length - a.length);

/** The kind of a file and the end of its name as written (`.CSV.gz`); undefined for a file of no supported kind. */
export interface FileType {
  readonly kind: FileKind;
  readonly suffix: string;
}

export function fileTypeOf(name: string): FileType | undefined {
  const lower = name.toLowerCase();
  for (const [suffix, kind] of SUFFIXES) {
    if (lower.endsWith(suffix)) return { kind, suffix: name.slice(name.length - suffix.length) };
  }
  return undefined;
}

/**
 * Whether a whole folder of the kind can be read through one glob. `read_xlsx` reads one file: given a glob it reads
 * only the first match, so Excel files are imported one by one.
 */
const readsGlob = (kind: FileKind): boolean => kind !== 'xlsx';

/** The files of one level grouped by the end of their name as written, for a glob: `*.csv` matches no `A.CSV`. */
export interface SuffixGroup {
  readonly suffix: string;
  readonly kind: FileKind;
  readonly count: number;
}

export function globGroups(names: readonly string[]): SuffixGroup[] {
  const groups = new Map<string, SuffixGroup>();
  for (const name of names) {
    const type = fileTypeOf(name);
    if (type === undefined || !readsGlob(type.kind)) continue;
    const found = groups.get(type.suffix);
    groups.set(type.suffix, { suffix: type.suffix, kind: type.kind, count: (found?.count ?? 0) + 1 });
  }
  return [...groups.values()].toSorted((a, b) => b.count - a.count || (a.suffix < b.suffix ? -1 : 1));
}
