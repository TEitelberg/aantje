import { isBelowDataPath } from '../catalog/locations';
import { extensionFailure, scrubbed } from '../duckdb/messages';
import { quackProblem } from '../duckdb/quack';
import { AantjeError } from '../errors';
import { dataAdvice, otherPlaceCause, storageContextOf } from '../storage/diagnose';
import type { StorageContext } from '../storage/diagnose';
import type { DataAccess, TableRef } from './types';

const VERSION_HINT =
  'aantje opens catalogs read-only and cannot migrate them: migrate the catalog with a matching DuckDB, or open a catalog of the supported DuckLake version.';

/** Where a statement failed; decides the error code and the advice. */
export type Phase = 'extension' | 'setup' | 'query';

/** The secrets of an access, for `maskSecrets`: every engine message goes through it before it is shown or logged. */
export function secretsOf(access: DataAccess): string[] {
  return [access.password, ...Object.values(access.storage?.values ?? {})].filter(
    (secret): secret is string => secret !== undefined,
  );
}

/** The user-facing error for a failed statement; message and cause are free of secrets. */
export function dataError(
  cause: unknown,
  phase: Phase,
  access: DataAccess,
  table: TableRef,
  catalog: CatalogFacts = {},
): AantjeError {
  const { text: raw, line: message } = scrubbed(cause, secretsOf(access));
  // Table and connection travel with the error so the health check can start from them.
  const where = { table, connectionId: access.profile.id };
  const options = { cause: new Error(message), ...where };
  if (phase === 'extension') {
    return extensionFailure('A DuckDB extension that aantje needs to read table data', message, where);
  }
  const quack = access.profile.kind === 'quack' ? quackProblem(message) : undefined;
  if (quack) {
    const code = phase === 'setup' && quack.code === 'QUERY_FAILED' ? 'CONNECTION_FAILED' : quack.code;
    return new AantjeError(
      code,
      `Cannot ${phase === 'setup' ? 'open the DuckLake to read table data' : `read the data of "${table.schema}.${table.table}"`}: ${quack.reason}.`,
      options,
    );
  }
  if (phase === 'setup') {
    const code = /authentication failed/i.test(message) ? 'AUTH_FAILED' : 'CONNECTION_FAILED';
    // DuckDB suggests AUTOMATIC_MIGRATION, which a read-only attach cannot use.
    const detail = /catalog version mismatch|Unsupported ducklake_version/i.test(message)
      ? `${message.replace(/ To automatically migrate.*$/, '')} ${VERSION_HINT}`
      : message;
    return new AantjeError(code, `Cannot open the DuckLake to read table data: ${detail}`, options);
  }
  // `table_changes` answers for a range outside the catalog or the table's life.
  const missing = /No snapshot found at version (\d+)/.exec(message)?.[1];
  if (missing !== undefined) {
    return new AantjeError(
      'QUERY_FAILED',
      `Snapshot @${missing} does not exist in this catalog: it is newer than the latest snapshot or it expired.`,
      options,
    );
  }
  const absent = /Table with name .* does not exist at version (\d+)/.exec(message)?.[1];
  if (absent !== undefined) {
    return new AantjeError(
      'QUERY_FAILED',
      `"${table.schema}.${table.table}" does not exist at snapshot @${absent}. Choose a range that ends at a snapshot where the table exists.`,
      options,
    );
  }
  const storage = storageContextOf(access.storage);
  const gone = MISSING_OBJECT.exec(raw);
  if (gone) {
    return new AantjeError(
      'QUERY_FAILED',
      `Cannot read the data of "${table.schema}.${table.table}": ${missingObjectText(gone, { pinned: access.snapshot, storage, ...catalog })}`,
      options,
    );
  }
  const absentFile = MISSING_LOCAL_FILE.exec(raw);
  if (absentFile) {
    return new AantjeError(
      'QUERY_FAILED',
      `Cannot read the data of "${table.schema}.${table.table}": ${missingLocalFileText(absentFile, { pinned: access.snapshot, ...catalog })}`,
      options,
    );
  }
  // File and network failures (missing Parquet file, access denied, unreachable endpoint) have these prefixes.
  const advice = /^(IO|HTTP) Error/.test(message) ? ` ${dataAdvice(storage)}` : '';
  return new AantjeError(
    'QUERY_FAILED',
    `Cannot read the data of "${table.schema}.${table.table}": ${message}.${advice}`,
    options,
  );
}

/**
 * First line of DuckDB's message when the object store answers 404 for a listed data file. Group 1 is the file url,
 * group 2 the S3 error code (NoSuchKey or NoSuchBucket) in the next paragraph; a proxy has none.
 */
export const MISSING_OBJECT =
  /HTTP (?:GET|HEAD) error \w+ '([^']+)' \(HTTP 404[^\n]*(?:\n\n(NoSuchKey|NoSuchBucket))?/;

const MISSING_ANSWER = {
  NoSuchKey: ' (NoSuchKey: the object does not exist)',
  NoSuchBucket: ' (NoSuchBucket: the bucket does not exist)',
};

/** What the catalog tells about a failed read; a fact is absent when its lookup failed. */
export interface CatalogFacts {
  /** The newest snapshot of the catalog. */
  readonly newest?: number;
  /** The `data_path` of the catalog, free of secrets. */
  readonly dataPath?: string;
  /** The storage of the connection, which words where to fix a sign-in or an endpoint; the machine's S3 settings if absent. */
  readonly storage?: StorageContext;
}

/**
 * First line of DuckDB's message for a data file missing on the local disk ("The system cannot find the file/path
 * specified" on Windows, "No such file or directory" elsewhere). Group 1 is the file, group 2 the system's answer.
 */
export const MISSING_LOCAL_FILE =
  /IO Error: Cannot open file "([^"]+)": (No such file or directory|The system cannot find the (?:file|path) specified)/;

/** Whether a `MISSING_OBJECT` or `MISSING_LOCAL_FILE` file lies below the data path, so the catalog lists it. */
export function isCatalogFile(match: RegExpExecArray, dataPath: string | undefined): boolean {
  return isBelowDataPath(match[1] ?? '', dataPath ?? null);
}

type ReadFacts = CatalogFacts & { readonly pinned?: number };

// Whether an older snapshot explains the missing file, and the sentence about the snapshot read.
function snapshotAdvice({ pinned, newest }: ReadFacts): { older: boolean; sentence: string } {
  const older = pinned !== undefined && (newest === undefined || pinned < newest);
  const sentence =
    pinned === undefined
      ? ''
      : newest === undefined
        ? ` This read used snapshot @${pinned}.`
        : older
          ? ` This read used snapshot @${pinned}, the newest is @${newest}: choose a newer snapshot or use Show Latest Snapshot.`
          : ` This read used the newest snapshot @${pinned}, so a newer snapshot will not help.`;
  return { older, sentence };
}

const OLDER_SNAPSHOT_CAUSE =
  'an older snapshot still lists a file that another writer or a manual cleanup removed afterwards';

/**
 * Text for a `MISSING_OBJECT` match: a file below the data path gets likely causes, any other url only the store's
 * answer. `pinned` is the snapshot read.
 */
export function missingObjectText(match: RegExpExecArray, facts: ReadFacts = {}): string {
  const [, url = '', code] = match;
  const answer = code === 'NoSuchKey' || code === 'NoSuchBucket' ? MISSING_ANSWER[code] : '';
  if (!isCatalogFile(match, facts.dataPath)) {
    return `the object store answered HTTP 404 for ${url}${answer}.`;
  }
  const { older, sentence } = snapshotAdvice(facts);
  const causes = [
    ...(older ? [OLDER_SNAPSHOT_CAUSE] : []),
    'the file was deleted or never written (a cleaned-up bucket, a manual delete, a storage volume that was reset)',
    otherPlaceCause(facts.storage ?? { perConnection: false }),
  ];
  return `the catalog lists the data file ${url}, but the object store answered HTTP 404${answer}. Likely causes: ${causes.join('; ')}.${sentence}`;
}

/** Text for a `MISSING_LOCAL_FILE` match; the system's answer stays in it because the health check recognises it. */
export function missingLocalFileText(match: RegExpExecArray, facts: ReadFacts = {}): string {
  const [, path = '', answer = ''] = match;
  const missing = `does not exist on this machine (${answer})`;
  if (!isCatalogFile(match, facts.dataPath)) {
    return `the file ${path} ${missing}.`;
  }
  const { older, sentence } = snapshotAdvice(facts);
  const causes = [
    ...(older ? [OLDER_SNAPSHOT_CAUSE] : []),
    'the file was removed or moved (a manual delete, a cleanup of the folder, a disk or share that is not mounted)',
    'the data_path of the catalog was changed or points to another folder than the one the lake was written to',
    'the lake lives on another machine and only the catalog was copied here',
  ];
  return `the catalog lists the data file ${path}, but it ${missing}. Likely causes: ${causes.join('; ')}.${sentence}`;
}
