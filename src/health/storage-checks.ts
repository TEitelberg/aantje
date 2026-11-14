import type { StoredFile } from '../catalog/model';
import { formatBytes, groupedPlural } from '../shell/numbers';
import { ago, capFindings, fileKey, fileScope, finding, kindText, META, qualified } from './finding';
import type { TableNames } from './finding';
import type { FindingScope, HealthFinding } from './model';
import type { StorageContext } from '../storage/diagnose';

/** A file in the object store as the listing returns it. */
export interface ListedFile {
  readonly key: string;
  readonly size: number;
  /** Milliseconds since 1970. */
  readonly modified: number;
}

// A younger file may be an upload a writer has not committed yet.
const RECENT_MS = 60 * 60_000;

// DuckLake writes an ADLS or OneLake path as `abfss://<container>@<host>/<key>`, but DuckDB lists it as
// `abfss://<host>/<container>/<key>`: the listed form is turned into the written one. The host is the DFS host of a
// storage account (`dfs.core.windows.net`, also sovereign clouds) or of OneLake (`dfs.fabric.microsoft.com`).
const LISTED_AZURE = /^(abfss?):\/\/([^/@]+\.dfs\.[^/]+)\/([^/]+)\//i;

/**
 * Turns Windows backslashes into slashes, drops `./` and writes an ADLS path the way DuckLake does;
 * `caseInsensitive` ignores case.
 */
export function comparable(path: string, caseInsensitive: boolean): string {
  const normal = path
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(
      LISTED_AZURE,
      (_, scheme: string, host: string, container: string) => `${scheme}://${container}@${host}/`,
    );
  return caseInsensitive ? normal.toLowerCase() : normal;
}

// DuckDB orders text by UTF-8 bytes, like object stores.
function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

interface StorageInput {
  readonly files: readonly StoredFile[];
  /** Full paths of files scheduled for deletion. */
  readonly scheduled: readonly string[];
  /** Full paths of other tables' files in the listed directory (a dropped table of the same name). */
  readonly shared: readonly string[];
  readonly listing: readonly ListedFile[];
  /** The listed directory, ending in `/`. */
  readonly directory: string;
  readonly scope: FindingScope;
  /** The listing was cut after this key. */
  readonly cutAfter?: string;
  readonly names: TableNames;
  readonly latest: number;
  readonly now: Date;
  /** Most findings reported per check. */
  readonly limit: number;
  readonly caseInsensitive: boolean;
  /** How the storage of the connection words the advice; the machine's S3 settings when not given. */
  readonly storage?: StorageContext;
}

interface StorageResult {
  readonly findings: readonly HealthFinding[];
  /** Findings counted but not reported. */
  readonly omitted: number;
  /** Catalog files not compared: outside the directory, beyond a cut listing, or without a place. */
  readonly notChecked: number;
  /** Every file the store lacks as `kind:id`, including those beyond the reporting limit. */
  readonly missing: ReadonlySet<string>;
}

/** Compares catalog files with store files: missing, other size, in no row. Pure. */
export function compareStorage(input: StorageInput): StorageResult {
  const {
    files,
    scheduled,
    shared,
    listing,
    directory,
    scope,
    cutAfter,
    names,
    latest,
    now,
    limit,
    caseInsensitive,
    storage,
  } = input;
  const key = (path: string): string => comparable(path, caseInsensitive);
  const inside = key(directory.endsWith('/') ? directory : `${directory}/`);
  const cut = cutAfter === undefined ? undefined : key(cutAfter);

  const stored = new Map<string, ListedFile>();
  for (const file of listing) {
    // An empty object standing for a folder is no file.
    if (!file.key.endsWith('/')) stored.set(key(file.key), file);
  }
  const known = new Set<string>([...scheduled, ...shared].map(key));
  const compared: { file: StoredFile; at: string }[] = [];
  let notChecked = 0;
  for (const file of files) {
    if (file.location === null) {
      notChecked++;
      continue;
    }
    const at = key(file.location);
    known.add(at);
    // A path with `..` leaves the directory whatever it starts with.
    if (
      !at.startsWith(inside) ||
      at.split('/').includes('..') ||
      (cut !== undefined && byBytes(at, cut) > 0)
    ) {
      notChecked++;
    } else {
      compared.push({ file, at });
    }
  }
  compared.sort(
    (a, b) => byBytes(a.at, b.at) || a.file.kind.localeCompare(b.file.kind) || a.file.id - b.file.id,
  );

  const missing = compared.filter(({ at }) => !stored.has(at));
  const resized = compared.filter(({ file, at }) => {
    const found = stored.get(at);
    return found !== undefined && file.sizeBytes !== null && found.size !== file.sizeBytes;
  });
  const orphans = [...stored]
    .filter(([at]) => !known.has(at))
    .sort(([a], [b]) => byBytes(a, b))
    .map(([, file]) => file);

  const findings: HealthFinding[] = [];
  let omitted = 0;
  const report = <T>(list: readonly T[], make: (item: T) => HealthFinding): void => {
    const capped = capFindings(list, limit);
    findings.push(...capped.shown.map(make));
    omitted += capped.omitted;
  };
  report(missing, ({ file }) => missingFinding(file, names, latest));
  report(resized, ({ file, at }) => resizedFinding(file, names, latest, stored.get(at)?.size ?? 0));
  report(orphans, (file) => orphanFinding(file, now, scope.kind === 'schema' ? scope : { kind: 'lake' }));
  if (listing.length === 0 && compared.some(({ file }) => file.endSnapshot === null)) {
    findings.push(nothingFound(directory, compared.length, scope, storage));
  }
  return {
    findings,
    omitted,
    notChecked,
    missing: new Set(missing.map(({ file }) => fileKey(file))),
  };
}

function inspect(file: StoredFile): string {
  return file.kind === 'data'
    ? `SELECT * FROM ${META}.ducklake_data_file WHERE data_file_id = ${file.id};`
    : `SELECT * FROM ${META}.ducklake_delete_file WHERE delete_file_id = ${file.id};`;
}

function serves(file: StoredFile, latest: number): string {
  if (file.endSnapshot === null) {
    return file.beginSnapshot >= latest
      ? `snapshot @${latest}`
      : `the snapshots @${file.beginSnapshot} to @${latest}`;
  }
  const last = file.endSnapshot - 1;
  return last <= file.beginSnapshot
    ? `snapshot @${file.beginSnapshot}`
    : `the snapshots @${file.beginSnapshot} to @${last}`;
}

export function missingFinding(file: StoredFile, names: TableNames, latest: number): HealthFinding {
  const scope = fileScope(file, names);
  const current = file.endSnapshot === null;
  const where = file.location ?? '';
  return finding('storage.file-missing', {
    severity: current ? 'error' : 'warning',
    scope,
    object: fileKey(file),
    title: current
      ? `A ${kindText(file)} that the newest snapshot needs is missing from the object store`
      : `A ${kindText(file)} that only older snapshots need is missing from the object store`,
    detail: `${where} is the ${kindText(file)} #${file.id} of ${qualified(scope)}. The catalog lists it for ${serves(file, latest)}, but the store has no such key. ${
      current
        ? `Reading ${qualified(scope)} at those snapshots fails with HTTP 404.`
        : 'The newest snapshot is not affected; time travel to those snapshots fails with HTTP 404.'
    }`,
    cause:
      'The file was deleted or never written (a bucket or volume that was reset, a lifecycle rule, a manual delete), or Delete Orphaned Files removed it while a writer had not committed it yet, or the endpoint points to another store than the one the lake was written to.',
    fix: current
      ? 'Restore the file under the same key from a backup or a replica of the bucket. Without it the rows of the file are lost: restore the catalog and the files from the same point in time. Clean Up Old Files and Expire Snapshots do not repair this.'
      : 'Restore the file under the same key, or accept that time travel to those snapshots is gone and expire them with Expire Snapshots.',
    inspectSql: inspect(file),
    objectKey: where,
  });
}

function resizedFinding(file: StoredFile, names: TableNames, latest: number, actual: number): HealthFinding {
  const scope = fileScope(file, names);
  const current = file.endSnapshot === null;
  const where = file.location ?? '';
  return finding('storage.file-size-mismatch', {
    severity: current ? 'error' : 'warning',
    scope,
    object: fileKey(file),
    title: 'A file in the object store has another size than the catalog records',
    detail: `${where} is the ${kindText(file)} #${file.id} of ${qualified(scope)} (${serves(file, latest)}). The catalog records ${groupedPlural(file.sizeBytes ?? 0, 'byte')} (${formatBytes(file.sizeBytes ?? 0)}), the store has ${groupedPlural(actual, 'byte')} (${formatBytes(actual)}).`,
    cause:
      'The file was replaced, cut off or written only in part after it was committed (an interrupted upload or copy, a tool that rewrote the key).',
    fix: 'Run the Deep check, which reads the end of the file, and restore the file from a backup if it is damaged.',
    inspectSql: inspect(file),
    objectKey: where,
  });
}

function orphanFinding(file: ListedFile, now: Date, scope: FindingScope): HealthFinding {
  const age = now.getTime() - file.modified;
  const recent = age < RECENT_MS;
  return finding('storage.file-orphaned', {
    severity: 'info',
    scope,
    object: file.key,
    title: 'A file in the object store belongs to no row of the catalog',
    detail: `${file.key} (${formatBytes(file.size)}, modified ${ago(age)}) lies below the data path. No data file or delete file row names it, and it is not scheduled for deletion.${recent ? ' It is very recent: a writer may have uploaded it and not committed yet.' : ''}`,
    cause:
      'A writer such as Sail or Spark uploaded it and has not committed yet, or a write failed or was rolled back and left it, or the catalog was restored to an older state.',
    fix: 'Do not delete it by hand. Delete Orphaned Files in the Maintenance menu starts with a dry run; give it an older_than that is later than your longest write, because a running writer that committed after the deletion would find its file gone.',
    objectKey: file.key,
  });
}

const NOTHING_FOUND_WHERE = {
  lake: 'below the data path',
  schema: 'in the directory of the schema',
  table: 'in the directory of the table',
} as const satisfies Record<FindingScope['kind'], string>;

function nothingFound(
  directory: string,
  expected: number,
  scope: FindingScope,
  storage: StorageContext | undefined,
): HealthFinding {
  const own = storage?.perConnection === true;
  return finding('storage.nothing-found', {
    severity: 'error',
    scope,
    title: `The object store holds no file ${NOTHING_FOUND_WHERE[scope.kind]}`,
    detail: `The catalog lists ${groupedPlural(expected, 'file')} below ${directory}, and the listing of that path returned nothing.`,
    cause:
      'The bucket, container or volume was reset or emptied, or the storage of the connection, the bucket or the data_path point to another place than the one the lake was written to.',
    fix: own
      ? 'Compare data_path with the bucket or container and prefix in the storage, and the storage of the connection (Edit Connection) with the account the lake lives in.'
      : 'Compare data_path with the bucket and prefix in the store, and aantje.s3.endpoint with the address of the store the lake lives in.',
    ...(own ? { connectionActions: ['editConnection' as const] } : { settingKey: 's3.endpoint' }),
    objectKey: directory,
  });
}
