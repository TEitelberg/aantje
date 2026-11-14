// The completion items of DuckLake: calls with the lake filled in, named arguments, statement snippets and snapshots.
import type { SnapshotInfo } from '../catalog/model';
import { quoteLiteral, sameIdentifier } from '../catalog/ddl';
import { snapshotDescription, snapshotTooltip } from '../tree/format';
import type { Env } from './completion-env';
import type { CursorContext } from './context';
import { functionDocumentation } from './help';

import type { FunctionInfo, Parameter } from './vocabulary';

// Newest snapshots first.
const MAX_SNAPSHOT_ITEMS = 200;

/** `$`, `}` and `\` stand for themselves in a snippet only when escaped. */
const escaped = (text: string): string => text.replace(/[$}\\]/g, '\\$&');

const positionalOf = (parameters: readonly Parameter[]): Parameter[] =>
  parameters.filter(({ named }) => !named);

// A name or a VARCHAR is written as a string literal: `'${1:table_name}'`.
const placeholder = ({ name, type }: Parameter, index: number): string =>
  type === 'VARCHAR' || name.endsWith('_name') ? `'\${${index}:${name}}'` : `\${${index}:${name}}`;

/**
 * A snippet that calls a function of DuckLake with the lake's name as the first argument and placeholders for the
 * other positional ones of its shortest overload; it ends inside the parentheses when named arguments may follow.
 */
export function lakeCallSnippet(fn: FunctionInfo, lake: string): string {
  const [shortest] = fn.overloads
    .map(({ parameters }) => positionalOf(parameters))
    .sort((a, b) => a.length - b.length);
  const others = (shortest ?? [])
    .slice(1)
    .map((parameter, index) => `, ${placeholder(parameter, index + 1)}`);
  const named = fn.overloads.some(({ parameters }) => parameters.some((parameter) => parameter.named));
  return `${escaped(`${fn.name}(${quoteLiteral(lake)}`)}${others.join('')}${named ? '$0)' : ')'}`;
}

/** The named arguments of the call at the cursor that are not given yet, once the positional ones are typed. */
export function namedArgumentDrafts({ drafts, context, vocabulary, lookup, call }: Env): void {
  if (!call?.argumentStart || context.qualifier.length > 0) return;
  const [head] = call.qualifier;
  const fn =
    head === undefined
      ? vocabulary.functions.get(call.name.toLowerCase())
      : call.qualifier.length === 1 && sameIdentifier(head, lookup.lake)
        ? vocabulary.lakeFunctions.get(call.name.toLowerCase())
        : undefined;
  if (!fn) return;
  const fewest = Math.min(...fn.overloads.map(({ parameters }) => positionalOf(parameters).length));
  if (call.activeParameter < fewest) return;
  const offered = new Set(call.named.map((name) => name.toLowerCase()));
  for (const { parameters } of fn.overloads) {
    for (const { name, type, named } of parameters) {
      if (!named || offered.has(name.toLowerCase())) continue;
      offered.add(name.toLowerCase());
      drafts.push({
        label: name,
        kind: 'parameter',
        insertText: `${name} => `,
        detail: type,
        group: 0,
        rank: offered.size,
      });
    }
  }
}

interface Snippet {
  readonly label: string;
  /** Snippet syntax; `{lake}` stands for the lake's name as an identifier, `{literal}` as a string literal. */
  readonly text: string;
  /** The function whose description documents the snippet. */
  readonly documentedBy?: string;
}

const dryRunSnippet = (name: string, extra = ''): Snippet => ({
  label: `CALL ${name} (dry run)`,
  text: `CALL ${name}({literal}${extra}, dry_run => true)`,
  documentedBy: name,
});

const callSnippet = (name: string): Snippet => ({
  label: `CALL ${name}`,
  text: `CALL ${name}({literal})`,
  documentedBy: name,
});

const STATEMENT_SNIPPETS: readonly Snippet[] = [
  { label: 'CHECKPOINT {lake}', text: 'CHECKPOINT {lake}' },
  { label: "COMMENT ON TABLE … IS '…'", text: "COMMENT ON TABLE ${1:table} IS '${2:comment}'" },
  {
    label: 'ALTER TABLE … SET PARTITIONED BY (…)',
    text: 'ALTER TABLE ${1:table} SET PARTITIONED BY (${2:column})',
  },
  { label: 'ALTER TABLE … SET SORTED BY (…)', text: 'ALTER TABLE ${1:table} SET SORTED BY (${2:column})' },
  callSnippet('ducklake_merge_adjacent_files'),
  callSnippet('ducklake_rewrite_data_files'),
  callSnippet('ducklake_flush_inlined_data'),
  dryRunSnippet('ducklake_expire_snapshots', ', older_than => now() - INTERVAL ${1:7 DAY}'),
  dryRunSnippet('ducklake_cleanup_old_files'),
  dryRunSnippet('ducklake_delete_orphaned_files'),
];

// After a relation of FROM, and after `ALTER TABLE t`.
const CLAUSE_SNIPPETS: Readonly<Record<string, readonly Snippet[]>> = {
  from: [
    { label: 'AT (VERSION => …)', text: 'AT (VERSION => ${1})' },
    { label: "AT (TIMESTAMP => '…')", text: "AT (TIMESTAMP => '${1}')" },
  ],
  alter: [
    { label: 'SET PARTITIONED BY (…)', text: 'SET PARTITIONED BY (${1:column})' },
    { label: 'SET SORTED BY (…)', text: 'SET SORTED BY (${1:column})' },
  ],
};

function snippetDrafts(
  { drafts, vocabulary, lookup, quote }: Env,
  snippets: readonly Snippet[],
  group: number,
): void {
  const fill = (text: string): string =>
    text
      .replaceAll('{lake}', escaped(quote(lookup.lake)))
      .replaceAll('{literal}', escaped(quoteLiteral(lookup.lake)));
  for (const [rank, { label, text, documentedBy }] of snippets.entries()) {
    const fn = documentedBy === undefined ? undefined : vocabulary.functions.get(documentedBy);
    drafts.push({
      label: label.replaceAll('{lake}', quote(lookup.lake)),
      kind: 'snippet',
      insertText: fill(text),
      snippet: true,
      documentation: fn && functionDocumentation(fn, lookup.lake),
      group,
      rank,
    });
  }
}

/** The DuckLake statements at the start of a statement. */
export function statementSnippetDrafts(env: Env, group: number): void {
  snippetDrafts(env, STATEMENT_SNIPPETS, group);
}

/** `AT (...)` after a relation of FROM, `SET PARTITIONED BY (...)` and `SET SORTED BY (...)` after `ALTER TABLE t`. */
export function clauseSnippetDrafts(env: Env, group: number): void {
  snippetDrafts(env, CLAUSE_SNIPPETS[env.context.clause] ?? [], group);
}

export function snapshotClauseDrafts({ drafts }: Env): void {
  drafts.push(
    {
      label: 'VERSION =>',
      kind: 'snapshot',
      insertText: 'VERSION => ',
      detail: 'a snapshot id',
      group: 0,
      rank: 0,
    },
    {
      label: 'TIMESTAMP =>',
      kind: 'snapshot',
      insertText: 'TIMESTAMP => ',
      detail: 'a point in time',
      group: 0,
      rank: 1,
    },
  );
}

interface SnapshotStyle {
  label(snapshot: SnapshotInfo): string;
  insertText(snapshot: SnapshotInfo, context: CursorContext): string;
  detail(snapshot: SnapshotInfo): string;
}

export const VERSION_SNAPSHOTS: SnapshotStyle = {
  label: (snapshot) => String(snapshot.id),
  insertText: (snapshot) => String(snapshot.id),
  detail: snapshotDescription,
};

// The reader truncates snapshot times to milliseconds, so the literal adds 1 ms. DuckLake takes the last snapshot
// at or before the time; the truncated time would find the snapshot below. Inside the quotes only the time is
// inserted, and the closing quote when it is missing.
export const TIMESTAMP_SNAPSHOTS: SnapshotStyle = {
  label: (snapshot) => snapshot.time.slice(0, 23).replace('T', ' '),
  insertText: (snapshot, { inString }) => {
    const time = new Date(Date.parse(snapshot.time) + 1).toISOString().replace('T', ' ').replace(/Z$/, '+00');
    return inString === undefined ? `'${time}'` : inString.closed ? time : `${time}'`;
  },
  detail: (snapshot) => `@${snapshot.id}`,
};

export async function snapshotDrafts({ drafts, context, lookup }: Env, style: SnapshotStyle): Promise<void> {
  const snapshots = (await lookup.catalog.snapshots()).slice(0, MAX_SNAPSHOT_ITEMS);
  for (const [rank, snapshot] of snapshots.entries()) {
    const label = style.label(snapshot);
    drafts.push({
      label,
      kind: 'snapshot',
      insertText: style.insertText(snapshot, context),
      detail: style.detail(snapshot),
      documentation: snapshotTooltip(snapshot),
      filterText: label,
      group: 0,
      rank,
    });
  }
}
