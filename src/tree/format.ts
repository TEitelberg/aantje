import type {
  ColumnInfo,
  ColumnTagEntry,
  MacroInfo,
  MacroParameter,
  PartitionColumn,
  PartitioningInfo,
  ResolvedChange,
  SchemaInfo,
  SnapshotInfo,
  SortExpression,
  SortOrderInfo,
  TableInfo,
  TagEntry,
  ViewInfo,
} from '../catalog/model';
import type { ConnectionKind, ConnectionProfile } from '../connections/profile';
import type { RelationColumn } from '../data/types';
import { describeAction, describeChanges, formatUtc } from '../snapshot';
import type { ConnectionState } from './refs';

// Descriptions and Markdown tooltips of the explorer nodes; pure.

const integer = new Intl.NumberFormat('en-US');

export function connectionDescription(kind: ConnectionKind, state: ConnectionState): string {
  switch (state.status) {
    case 'disconnected':
      return kind;
    case 'connecting':
      return `${kind} · connecting…`;
    case 'error':
      return `${kind} · connection failed`;
    case 'connected':
      return [kind, state.specVersion && `DuckLake ${state.specVersion}`, snapshotLabel(state)]
        .filter(Boolean)
        .join(' · ');
  }
}

export function connectionTooltip(profile: ConnectionProfile, state: ConnectionState): string {
  const facts = [
    profile.kind === 'postgres'
      ? `Server: ${inlineCode(`${profile.host}:${profile.port}/${profile.database}`)}`
      : profile.kind === 'quack'
        ? `Server: ${inlineCode(`${profile.host}:${profile.port}`)}`
        : `File: ${inlineCode(profile.path)}`,
  ];
  if (state.status === 'connected') {
    if (state.specVersion) {
      facts.push(`DuckLake specification: ${state.specVersion}`);
    }
    facts.push(`Snapshot: ${snapshotLabel(state)}`);
    if (state.snapshot !== 'latest' && state.latestSnapshot !== undefined) {
      facts.push(`Latest snapshot: @${state.latestSnapshot}`);
    }
  }
  return blocks(
    `**${markdownText(profile.name)}** (${profile.kind})`,
    list(facts),
    state.error && markdownText(state.error),
  );
}

export function schemaTooltip(schema: SchemaInfo): string | undefined {
  return schema.comment ? blocks(inlineCode(schema.name), markdownText(schema.comment)) : undefined;
}

/** The row count, prefixed with `~` when approximate (see `APPROXIMATE_ROWS`). */
export function tableDescription(table: TableInfo): string {
  const { rows, approximate } = table.stats;
  return `${approximate ? '~' : ''}${integer.format(rows)} ${rows === 1 ? 'row' : 'rows'}`;
}

const APPROXIMATE_ROWS =
  'Approximate: a compacted data file or a delete file covers later snapshots too, so the count can be too high or too low. Rows in data files only; inlined rows are not included.';

export function tableTooltip(schema: SchemaInfo, table: TableInfo): string {
  const { rows, files, sizeBytes, approximate } = table.stats;
  return blocks(
    inlineCode(`${schema.name}.${table.name}`),
    table.comment && markdownText(table.comment),
    list([
      `Rows in data files (inlined rows not included): ${approximate ? '~' : ''}${integer.format(rows)}`,
      `Data files: ${integer.format(files)}`,
      `Size: ${formatBytes(sizeBytes)}`,
    ]),
    approximate && APPROXIMATE_ROWS,
  );
}

export function viewTooltip(schema: SchemaInfo, view: ViewInfo): string {
  return blocks(
    inlineCode(`${schema.name}.${view.name}`),
    view.comment && markdownText(view.comment),
    `Definition (dialect: ${markdownText(view.dialect)}):`,
    codeBlock(view.sql, 'sql'),
  );
}

/** A leaf below a folder; the model assigns its id. */
export interface TreeDetail {
  readonly label: string;
  readonly description?: string;
  /** Markdown. */
  readonly tooltip?: string;
  readonly icon: string;
}

export function columnDescription(column: Pick<ColumnInfo, 'type' | 'nullable'>): string {
  return column.nullable ? column.type : `${column.type} NOT NULL`;
}

export function viewColumnTooltip(schema: SchemaInfo, view: ViewInfo, column: RelationColumn): string {
  return blocks(
    inlineCode(`${schema.name}.${view.name}.${column.name}`),
    list([`Type: ${inlineCode(column.type)}`, `Nullable: ${column.nullable ? 'yes' : 'no'}`]),
  );
}

export function columnTooltip(
  schema: SchemaInfo,
  table: TableInfo,
  path: readonly string[],
  column: ColumnInfo,
): string {
  const facts = [`Type: ${inlineCode(column.type)}`, `Nullable: ${column.nullable ? 'yes' : 'no'}`];
  if (column.defaultValue !== null) {
    facts.push(`Default: ${inlineCode(column.defaultValue)}`);
  }
  return blocks(
    inlineCode([schema.name, table.name, ...path].join('.')),
    column.comment && markdownText(column.comment),
    list(facts),
  );
}

// `scalar (net, rate := 1.19)`: parameters of the first implementation.
export function macroDescription(macro: MacroInfo): string {
  const parameters = macro.implementations[0]?.parameters ?? [];
  return `${macro.kind} (${parameters.map(parameterText).join(', ')})`;
}

function parameterText({ name, type, defaultValue }: MacroParameter): string {
  return `${name}${type === null ? '' : ` ${type}`}${defaultValue === null ? '' : ` := ${defaultValue}`}`;
}

export function macroTooltip(schema: SchemaInfo, macro: MacroInfo): string {
  return blocks(
    `${inlineCode(`${schema.name}.${macro.name}`)} (${macro.kind} macro)`,
    ...macro.implementations.map(({ dialect, parameters, sql }) =>
      blocks(
        `Dialect: ${markdownText(dialect)}`,
        parameters.length > 0 &&
          `Parameters: ${parameters.map((p) => inlineCode(parameterText(p))).join(', ')}`,
        codeBlock(sql, 'sql'),
      ),
    ),
  );
}

export function partitioningTooltip(partitioning: PartitioningInfo): string {
  return `Partitioning since snapshot @${partitioning.beginSnapshot}.`;
}

export function partitionDetail(schema: SchemaInfo, table: TableInfo, column: PartitionColumn): TreeDetail {
  const path = column.path.join('.');
  return {
    label: path,
    description: column.transform,
    tooltip: blocks(
      inlineCode(`${schema.name}.${table.name}.${path}`),
      list([`Transform: ${inlineCode(column.transform)}`]),
    ),
    icon: 'split-horizontal',
  };
}

export function sortOrderTooltip(sortOrder: SortOrderInfo): string {
  return `Sort order since snapshot @${sortOrder.beginSnapshot}.`;
}

export function sortDetail(schema: SchemaInfo, table: TableInfo, sort: SortExpression): TreeDetail {
  const nulls = sort.nullOrder.replaceAll('_', ' ');
  return {
    label: sort.expression,
    description: `${sort.direction} ${nulls}`,
    tooltip: blocks(
      inlineCode(`${schema.name}.${table.name}`),
      list([
        `Expression: ${inlineCode(sort.expression)}`,
        `Direction: ${inlineCode(sort.direction)}`,
        `Null order: ${inlineCode(nulls)}`,
      ]),
    ),
    icon: 'sort-precedence',
  };
}

export function tableTagDetail(schema: SchemaInfo, table: TableInfo, tag: TagEntry): TreeDetail {
  return {
    label: tag.key,
    description: tag.value,
    tooltip: blocks(inlineCode(`${schema.name}.${table.name}`), tagFacts(tag)),
    icon: 'tag',
  };
}

export function columnTagDetail(schema: SchemaInfo, table: TableInfo, tag: ColumnTagEntry): TreeDetail {
  const path = tag.path.join('.');
  return {
    label: path,
    description: `${tag.key}: ${tag.value}`,
    tooltip: blocks(inlineCode(`${schema.name}.${table.name}.${path}`), tagFacts(tag)),
    icon: 'tag',
  };
}

function tagFacts({ key, value }: TagEntry): string {
  return list([`Tag: ${inlineCode(key)}`, `Value: ${inlineCode(value)}`]);
}

export function snapshotDescription(snapshot: SnapshotInfo): string {
  return formatUtc(snapshot.time);
}

export function snapshotTooltip(snapshot: SnapshotInfo): string {
  return snapshotFacts(
    `@${snapshot.id}`,
    snapshot,
    `Changes: ${markdownText(describeChanges(snapshot.changes))}`,
  );
}

export function snapshotsFolderTooltip(truncated: boolean): string | undefined {
  return truncated ? 'Only the newest snapshots are listed.' : undefined;
}

function snapshotFacts(
  title: string,
  { time, author, commitMessage }: { time: string; author: string | null; commitMessage: string | null },
  changes: string,
): string {
  return blocks(
    inlineCode(title),
    list([`Time: ${formatUtc(time)}`, ...(author === null ? [] : [`Author: ${inlineCode(author)}`])]),
    changes,
    commitMessage && `Commit message: ${markdownText(commitMessage)}`,
  );
}

/** One change of a snapshot: the catalog's object name and what happened to it. */
export function changeDetail(change: ResolvedChange): TreeDetail {
  const name = change.name === null ? undefined : [change.schemaName, change.name].filter(Boolean).join('.');
  return {
    label: name ?? change.raw,
    description: change.object === null ? undefined : describeAction(change.action, change.object),
    tooltip: `Stored as ${inlineCode(change.raw)}.`,
    icon: 'diff',
  };
}

function snapshotLabel({ snapshot, latestSnapshot }: ConnectionState): string {
  return snapshot === 'latest' ? `@${String(latestSnapshot)}` : `@${snapshot} (pinned)`;
}

/** Binary units (1 KB = 1024 B), one decimal at most. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    // Compare the rounded value: 1023.96 KB must become 1 MB, not "1024 KB".
    const rounded = Number(value.toFixed(1));
    if (rounded < 1024) {
      return `${rounded} ${unit}`;
    }
    value /= 1024;
  }
  return `${Number(value.toFixed(1))} TB`;
}

function blocks(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join('\n\n');
}

function list(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

// Escapes catalog text so no Markdown renders. CommonMark allows a backslash before any ASCII punctuation,
// which covers list markers, setext underlines, entities and bare URLs.
export function markdownText(text: string): string {
  return text
    .replace(INVISIBLE_EXCEPT_BREAKS, '')
    .replace(/[!-/:-@[-`{-~]/g, '\\$&')
    .replace(/\r?\n/g, '  \n');
}

// Control and invisible format characters (bidi overrides, zero-width joiners) and Unicode line/paragraph
// separators. They can reorder the surrounding text, so names and comments show without them.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// Keeps tab and line breaks: markdownText turns comment line breaks into hard breaks.
const INVISIBLE_EXCEPT_BREAKS = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

// Code span for catalog text. Whitespace collapses to one space: a blank line would end the paragraph
// and render the rest of the name as Markdown.
export function inlineCode(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').replace(INVISIBLE, '');
  const fence = backticks(text, 1);
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

// Like `inlineCode` without the invisible characters, but the lines stay: a bidi override in the SQL of a view would
// reorder the text around it.
export function codeBlock(raw: string, language: string): string {
  const text = raw.replace(INVISIBLE_EXCEPT_BREAKS, '');
  const fence = backticks(text, 3);
  return `${fence}${language}\n${text}\n${fence}`;
}

// A backtick run longer than any inside the text, so the text cannot end its own code.
function backticks(text: string, minimum: number): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  return '`'.repeat(Math.max(minimum, longest + 1));
}
