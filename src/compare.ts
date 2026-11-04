import { createTableDdl } from './catalog/ddl';
import type { CatalogEntry, CatalogReader, ColumnInfo, SnapshotId, SnapshotInfo } from './catalog/model';
import { diffColumns, diffEntries } from './catalog/schema-diff';
import type { ColumnChange, EntryChange } from './catalog/schema-diff';
import { plural } from './shell/numbers';
import { formatUtc } from './snapshot';
import { namesAt } from './time-travel';
import type { Subject } from './time-travel';
import { inlineCode, markdownText } from './tree/format';

// Compare Schema and Compare Snapshots: counts, DDL documents and report; the commands only show them.

interface DocumentKey {
  readonly connectionId: string;
  readonly tableId: number;
  readonly snapshot: SnapshotId;
}

/** The URI path and query of the DDL document; table names stay out of the path because a name can start with `//`. */
export function documentAddress({ connectionId, tableId, snapshot }: DocumentKey): {
  readonly path: string;
  readonly query: string;
} {
  return { path: `/${tableId}@${snapshot}.sql`, query: connectionId };
}

export interface SchemaDocument {
  readonly key: DocumentKey;
  readonly text: string;
}

export interface SchemaComparison {
  /** The information message: the column change counts, or that there are none. */
  readonly summary: string;
  /** `schema.table: @A ↔ @B`, the table named as at B. */
  readonly title: string;
  /** The `CREATE TABLE` of A and B; absent when both texts are equal. */
  readonly documents?: { readonly left: SchemaDocument; readonly right: SchemaDocument };
}

interface TableState {
  readonly schemaName: string;
  readonly name: string;
  readonly columns: readonly ColumnInfo[];
}

// Names are read at the snapshot too: a rename in between makes them differ.
async function tableAt(
  reader: Pick<CatalogReader, 'columns' | 'entries'>,
  subject: Subject,
  snapshot: SnapshotId,
): Promise<TableState> {
  const [columns, names] = await Promise.all([
    reader.columns(subject.id, snapshot),
    namesAt(reader, subject, snapshot),
  ]);
  return { ...names, columns };
}

/** The column changes of a table between two snapshots (`from` is the older), as text and two DDL documents. */
export async function compareSchema(
  reader: Pick<CatalogReader, 'columns' | 'entries'>,
  connectionId: string,
  subject: Subject,
  from: SnapshotId,
  to: SnapshotId,
): Promise<SchemaComparison> {
  const [before, after] = await Promise.all([tableAt(reader, subject, from), tableAt(reader, subject, to)]);
  const renamed = before.schemaName !== after.schemaName || before.name !== after.name;
  const left = createTableDdl(before.schemaName, before.name, before.columns);
  const right = createTableDdl(after.schemaName, after.name, after.columns);
  return {
    summary: summarize(diffColumns(before.columns, after.columns), renamed, from, to),
    title: `${after.schemaName}.${after.name}: @${from} ↔ @${to}`,
    ...(left === right
      ? {}
      : {
          documents: {
            left: { key: { connectionId, tableId: subject.id, snapshot: from }, text: left },
            right: { key: { connectionId, tableId: subject.id, snapshot: to }, text: right },
          },
        }),
  };
}

const KINDS: readonly [ColumnChange['change'], string][] = [
  ['added', 'added'],
  ['removed', 'removed'],
  ['renamed', 'renamed'],
  ['typeChanged', 'type changed'],
  ['nullableChanged', 'nullability changed'],
  ['defaultChanged', 'default changed'],
  ['commentChanged', 'comment changed'],
  ['moved', 'moved'],
];

// `2 columns added, 1 renamed, 1 type changed between @26 and @34`; nested fields count as columns.
function summarize(
  changes: readonly ColumnChange[],
  tableRenamed: boolean,
  from: number,
  to: number,
): string {
  const counts = KINDS.map(
    ([kind, verb]) => [changes.filter(({ change }) => change === kind).length, verb] as const,
  )
    .filter(([count]) => count > 0)
    .map(
      ([count, verb], index) =>
        `${count} ${index === 0 ? `${count === 1 ? 'column' : 'columns'} ` : ''}${verb}`,
    );
  const parts = [...(tableRenamed ? ['table renamed'] : []), ...counts];
  return parts.length === 0
    ? `No schema changes between @${from} and @${to}`
    : `${parts.join(', ')} between @${from} and @${to}`;
}

/** Caps what a catalog comparison reads and lists; a catalog can have thousands of tables. */
export interface CompareLimits {
  /** Tables present at both snapshots whose columns are compared. */
  readonly tables: number;
  /** Entries listed per section (added, dropped, renamed). */
  readonly entries: number;
  readonly changes: number;
}

const COMPARE_LIMITS: CompareLimits = { tables: 200, entries: 100, changes: 50 };

// Tables whose columns are read at the same time, each at both snapshots.
const READ_AT_ONCE = 4;

interface CatalogComparison {
  readonly entries: readonly EntryChange[];
  /** Compared tables with column changes, named as at B. */
  readonly tables: readonly { readonly entry: CatalogEntry; readonly changes: readonly ColumnChange[] }[];
  readonly compared: number;
  /** Tables at both snapshots left uncompared by the limit. */
  readonly omitted: number;
}

/** Diffs entries over all tables and views, and columns of tables at both snapshots (matched by id), up to `limits.tables`. */
export async function compareCatalog(
  reader: Pick<CatalogReader, 'entries' | 'columns'>,
  from: SnapshotId,
  to: SnapshotId,
  limits: CompareLimits = COMPARE_LIMITS,
): Promise<CatalogComparison> {
  const [before, after] = await Promise.all([reader.entries(from), reader.entries(to)]);
  // A table and a view never share an id, so the ids of the views at `from` match no table at `to`.
  const earlier = new Set(before.map(({ id }) => id));
  const both = after.filter(({ kind, id }) => kind === 'table' && earlier.has(id));
  const compared = both.slice(0, limits.tables);
  const tables: { entry: CatalogEntry; changes: ColumnChange[] }[] = [];
  for (let start = 0; start < compared.length; start += READ_AT_ONCE) {
    const batch = await Promise.all(
      compared.slice(start, start + READ_AT_ONCE).map(async (entry) => {
        const [older, newer] = await Promise.all([
          reader.columns(entry.id, from),
          reader.columns(entry.id, to),
        ]);
        return { entry, changes: diffColumns(older, newer) };
      }),
    );
    tables.push(...batch.filter(({ changes }) => changes.length > 0));
  }
  return {
    entries: diffEntries(before, after),
    tables,
    compared: compared.length,
    omitted: both.length - compared.length,
  };
}

const code = (names: readonly string[]): string => inlineCode(names.join('.'));
const valueOrNone = (value: string | null): string => (value === null ? 'none' : inlineCode(value));

/** One column change as a Markdown line; catalog names and values render as code. */
export function describeColumnChange(change: ColumnChange): string {
  const name = code(change.path);
  switch (change.change) {
    case 'added':
      return `added ${name} (${inlineCode(change.type)})`;
    case 'removed':
      return `removed ${name} (${inlineCode(change.type)})`;
    case 'renamed':
      return `renamed ${code([...change.path.slice(0, -1), change.from])} to ${name}`;
    case 'typeChanged':
      return `type of ${name} changed from ${inlineCode(change.from)} to ${inlineCode(change.to)}`;
    case 'nullableChanged':
      return `${name} is now ${change.to ? 'nullable' : 'NOT NULL'}`;
    case 'defaultChanged':
      return `default of ${name} changed from ${valueOrNone(change.from)} to ${valueOrNone(change.to)}`;
    case 'commentChanged':
      return `comment of ${name} changed`;
    case 'moved':
      return `moved ${name} from position ${change.from + 1} to ${change.to + 1}`;
  }
}

function entryLine(change: EntryChange): string {
  const now = inlineCode(`${change.schemaName}.${change.name}`);
  return change.change === 'renamed'
    ? `${change.kind} ${inlineCode(`${change.from.schemaName}.${change.from.name}`)} is now ${now}`
    : `${change.kind} ${now}`;
}

function capped(lines: readonly string[], limit: number): string[] {
  const rest = lines.length - limit;
  return rest > 0 ? [...lines.slice(0, limit), `- … ${rest} more omitted`] : [...lines];
}

/** The Markdown report of Compare Snapshots; catalog text renders as code and lists cut at the limits. */
export function comparisonMarkdown(input: {
  readonly connectionName: string;
  readonly from: { readonly id: SnapshotId; readonly time?: string };
  readonly to: { readonly id: SnapshotId; readonly time?: string };
  readonly comparison: CatalogComparison;
  readonly limits?: CompareLimits;
}): string {
  const { connectionName, from, to, comparison, limits = COMPARE_LIMITS } = input;
  const snapshot = ({ id, time }: { id: SnapshotId; time?: string }): string =>
    `@${id}${time === undefined ? '' : `, ${formatUtc(time)}`}`;
  const sections = (['Added', 'Dropped', 'Renamed'] as const).flatMap((title) => {
    const kind = title.toLowerCase();
    const changes = comparison.entries.filter(({ change }) => change === kind);
    return changes.length === 0
      ? []
      : [
          `### ${title} (${changes.length})`,
          '',
          ...capped(
            changes.map((change) => `- ${entryLine(change)}`),
            limits.entries,
          ),
          '',
        ];
  });
  const compared = `Compared ${plural(comparison.compared, 'table')} that ${comparison.compared === 1 ? 'exists' : 'exist'} at both snapshots. ${
    comparison.tables.length === 0
      ? 'None has'
      : `${comparison.tables.length} of them ${comparison.tables.length === 1 ? 'has' : 'have'}`
  } column changes.${
    comparison.omitted > 0
      ? ` ${plural(comparison.omitted, 'more table')} that ${comparison.omitted === 1 ? 'exists' : 'exist'} at both snapshots and ${comparison.omitted === 1 ? 'was' : 'were'} not compared (limit: ${limits.tables}).`
      : ''
  }`;
  return [
    `# ${markdownText(connectionName.replace(/\s+/g, ' ').trim())}: @${from.id} to @${to.id}`,
    '',
    `- From: ${snapshot(from)}`,
    `- To: ${snapshot(to)}`,
    '',
    '## Tables and views',
    '',
    ...(sections.length === 0 ? ['No table or view was added, dropped or renamed.', ''] : sections),
    '## Columns',
    '',
    compared,
    '',
    ...comparison.tables.flatMap(({ entry, changes }) => [
      `### ${inlineCode(`${entry.schemaName}.${entry.name}`)}`,
      '',
      ...capped(
        changes.map((change) => `- ${describeColumnChange(change)}`),
        limits.changes,
      ),
      '',
    ]),
  ].join('\n');
}

/** The Compare Snapshots report for two snapshots of the list (`from` is the older). */
export async function snapshotsReport(
  reader: Pick<CatalogReader, 'entries' | 'columns'>,
  connectionName: string,
  snapshots: readonly SnapshotInfo[],
  from: SnapshotId,
  to: SnapshotId,
): Promise<string> {
  const timeOf = (id: SnapshotId): string | undefined =>
    snapshots.find((snapshot) => snapshot.id === id)?.time;
  return comparisonMarkdown({
    connectionName,
    from: { id: from, time: timeOf(from) },
    to: { id: to, time: timeOf(to) },
    comparison: await compareCatalog(reader, from, to),
  });
}
