import type { StoredFile } from '../catalog/model';
import { quoteLiteral } from '../catalog/ddl';
import { groupedPlural } from '../shell/numbers';
import { fileKey, fileScope, finding, kindText, qualified } from './finding';
import type { TableNames } from './finding';
import { escapeGlob } from '../data/store-sql';
import type { HealthFinding } from './model';
import { storeProblemOf } from '../storage/diagnose';
import type { StorageKind } from '../storage/config';

interface FileColumn {
  readonly name: string;
  readonly fieldId: number | null;
}

interface FooterFacts {
  readonly rows: number;
  /** Top-level schema columns; struct fields and list elements are not included. */
  readonly columns: readonly FileColumn[];
}

// The files the deep check opens: those the newest snapshot needs and DuckDB can read, largest half first, then
// newest. Encrypted, placeless and non-Parquet files (deletion vectors) are left out; ties break by id.
export function chooseDeepFiles(
  files: readonly StoredFile[],
  limit: number,
): { chosen: StoredFile[]; eligible: number } {
  const eligible = files.filter(
    (file) =>
      file.endSnapshot === null && file.location !== null && !file.encrypted && file.format === 'parquet',
  );
  const largest = eligible
    .toSorted(
      (a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || a.kind.localeCompare(b.kind) || a.id - b.id,
    )
    .slice(0, Math.ceil(limit / 2));
  const taken = new Set(largest);
  const newest = eligible
    .filter((file) => !taken.has(file))
    .toSorted((a, b) => b.beginSnapshot - a.beginSnapshot || a.kind.localeCompare(b.kind) || b.id - a.id)
    .slice(0, limit - largest.length);
  return { chosen: [...largest, ...newest], eligible: eligible.length };
}

// Glob characters become classes, so the name matches itself.
function pathArgument(location: string): string {
  return quoteLiteral(escapeGlob(location));
}

export function footerStatement(location: string): string {
  return `SELECT num_rows FROM parquet_file_metadata(${pathArgument(location)})`;
}

export function schemaStatement(location: string): string {
  return `SELECT name, num_children, field_id FROM parquet_schema(${pathArgument(location)})`;
}

/** The top-level columns of `parquet_schema` rows, which list the root, then fields depth first; `children` counts a field's next fields. */
export function topLevelColumns(
  rows: readonly (readonly [name: string, children: number | null, fieldId: number | null])[],
): FileColumn[] {
  const columns: FileColumn[] = [];
  let index = 1;
  const skip = (): void => {
    const children = rows[index]?.[1] ?? 0;
    index++;
    for (let child = 0; child < children; child++) skip();
  };
  while (index < rows.length) {
    const [name, , fieldId] = rows[index] ?? ['', null, null];
    columns.push({ name, fieldId });
    skip();
  }
  return columns;
}

/** The columns the table has or had; a file column outside them is a stranger. */
export interface KnownColumns {
  readonly ids: ReadonlySet<number>;
  readonly names: ReadonlySet<string>;
}

const INTERNAL = /^_ducklake_internal_/;

export function deepFindings(
  file: StoredFile,
  footer: FooterFacts,
  known: KnownColumns,
  names: TableNames,
): HealthFinding[] {
  const scope = fileScope(file, names);
  const where = file.location ?? '';
  const object = fileKey(file);
  const kind = kindText(file);
  const findings: HealthFinding[] = [];
  if (file.records !== null && footer.rows !== file.records) {
    findings.push(
      finding('deep.row-count-mismatch', {
        severity: 'error',
        scope,
        object,
        title: 'A Parquet file holds another number of rows than the catalog says',
        detail: `${where} is the ${kind} #${file.id} of ${qualified(scope)}. Its footer says ${groupedPlural(footer.rows, 'row')}, the catalog records ${groupedPlural(file.records, 'row')}.`,
        cause:
          'The file was replaced by another one under the same name, or the count of the catalog is wrong.',
        fix: 'Row counts, deletes and Show Changes rely on the count. Restore the file from a backup, or restore the catalog to the state that matches the file.',
        inspectSql: footerSql(file),
        objectKey: where,
      }),
    );
  }
  // DuckLake files carry the column id as field id; files without it match by name. Columns DuckLake adds itself
  // (row id, snapshot of a compacted file) and the fixed delete file columns are not table columns.
  const columns = file.kind === 'data' ? footer.columns.filter((column) => !INTERNAL.test(column.name)) : [];
  const withIds = columns.length > 0 && columns.every((column) => column.fieldId !== null);
  const strangers = columns.filter((column) =>
    withIds ? !known.ids.has(column.fieldId ?? -1) : !known.names.has(column.name),
  );
  if (strangers.length > 0) {
    findings.push(
      finding('deep.columns-unknown', {
        severity: 'warning',
        scope,
        object,
        title: 'A Parquet file has columns that the table never had',
        detail: `${where} is the ${kind} #${file.id} of ${qualified(scope)}. ${strangers.map((column) => (withIds ? `${column.name} (field id ${column.fieldId})` : column.name)).join(', ')} ${strangers.length === 1 ? 'is' : 'are'} not among the columns the table has had.`,
        cause:
          'The file belongs to another table or was written with another schema, for example a file that was added by hand.',
        fix: 'Find out where the file came from. Reading the table may fail or return NULL for the columns.',
        inspectSql: schemaSql(file),
        objectKey: where,
      }),
    );
  }
  return findings;
}

const STILL_BUSY = /still busy/;

type FailureKind = 'busy' | 'store' | 'gone' | 'unreadable';

/** Classifies a failed footer read as engine busy, store silent, file gone or bad file; the first two end the deep check. */
export function failureKind(text: string, storage?: StorageKind): FailureKind {
  if (STILL_BUSY.test(text)) return 'busy';
  switch (storeProblemOf(text, storage)) {
    case 'denied':
    case 'expired':
    case 'role':
    case 'unresolved':
    case 'ssl':
    case 'unreachable':
      return 'store';
    case 'no-bucket':
    case 'not-found':
    case 'missing-file':
      return 'gone';
    default:
      return 'unreadable';
  }
}

/** A file whose footer cannot be read; `text` is the first line of the engine's message. */
export function unreadableFinding(file: StoredFile, text: string, names: TableNames): HealthFinding {
  const scope = fileScope(file, names);
  const where = file.location ?? '';
  return finding('deep.file-unreadable', {
    severity: 'error',
    scope,
    object: fileKey(file),
    title: 'A Parquet file cannot be read',
    detail: `${where} is the ${kindText(file)} #${file.id} of ${qualified(scope)}. ${text}`,
    cause:
      'The file is damaged (cut off or overwritten), is no Parquet file, or the store did not deliver it in time.',
    fix: 'Restore the file from a backup. The rows in it cannot be read until then; Show Changes and reads of the table fail the same way.',
    inspectSql: footerSql(file),
    objectKey: where,
  });
}

function footerSql(file: StoredFile): string {
  return `${footerStatement(file.location ?? '')};`;
}

function schemaSql(file: StoredFile): string {
  return `${schemaStatement(file.location ?? '')};`;
}
