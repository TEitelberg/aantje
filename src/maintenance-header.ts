import { globalValue } from './catalog/model';
import type { MetadataEntry } from './catalog/model';

/** The options that the destructive scripts and Checkpoint follow. */
const WATCHED = [
  'expire_older_than',
  'delete_older_than',
  'rewrite_delete_threshold',
  'target_file_size',
  'auto_compact',
] as const;

/** The global value of each watched option, null for one that is not set. */
export type LakeOptions = Readonly<Record<(typeof WATCHED)[number], string | null>>;

export const lakeOptionsOf = (entries: readonly MetadataEntry[]): LakeOptions =>
  Object.fromEntries(WATCHED.map((name) => [name, globalValue(entries, name)])) as LakeOptions;

// The value comes from the catalog: only plain words and numbers go into a comment.
const SAFE_VALUE = /^[\w. :+-]{1,40}$/;

function shown(value: string | null): string {
  if (value === null) {
    return 'not set';
  }
  return SAFE_VALUE.test(value) ? value : 'set (not shown)';
}

/** The header lines with the option values; `null` says that they could not be read. */
export function optionHeader(options: LakeOptions | null): string[] {
  if (options === null) {
    return [
      `-- The current values of ${WATCHED.join(', ')} are not available: the options could not be read.`,
    ];
  }
  return [
    '-- Options of the lake when this script was made (this script follows them):',
    ...WATCHED.map((name) => `--   ${name} = ${shown(options[name])}`),
  ];
}
