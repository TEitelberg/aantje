import { parameterDefinition } from '../catalog/ddl';
import type { MacroInfo, ViewInfo } from '../catalog/model';
import { capped, COMPARE_LIMITS, describeColumnChange, valueOrNone } from '../compare';
import { commentName } from '../ddl-script/names';
import { markdownTable } from '../markdown';
import { plural } from '../shell/numbers';
import { codeBlock, inlineCode, markdownText } from '../markdown';
import { listed, mayHideRename, RENAME_NOTE } from './model';
import type { ColumnDifference, TableDifferences } from './model';
import { differs } from './schemas';
import type { Paired, SchemaComparison } from './schemas';
import { sideName } from './tables';
import type { Side } from './tables';

/** Cuts of the report, as in Compare Snapshots; a cut says how much it left out. */
const LIMITS = { ...COMPARE_LIMITS, text: 4000 };

export interface SchemaSide extends Side {
  readonly schemaName: string;
}

/** The counts of one kind of object, whatever the kind. */
interface Counted {
  readonly onlyLeft: readonly unknown[];
  readonly onlyRight: readonly unknown[];
  readonly different: readonly unknown[];
  readonly equal: number;
}

const macroKind = (macro: MacroInfo): string => `${macro.kind} macro`;

function cut(text: string): string {
  const rest = text.length - LIMITS.text;
  return rest > 0 ? `${text.slice(0, LIMITS.text)}\n… ${rest} more characters omitted` : text;
}

/** The definition of a view as the catalog stores it, after its column names, each quoted on the comment line. */
function viewText(view: ViewInfo): string {
  const aliases = view.columnAliases.map((alias) => commentName(alias)).join(', ');
  return `${aliases === '' ? '' : `-- column names: ${aliases}\n`}${view.sql}`;
}

/** The overloads of a macro as the catalog stores them: parameters and body, one per line. */
const macroText = (macro: MacroInfo): string =>
  macro.implementations
    .map(({ parameters, sql }) => `(${parameters.map(parameterDefinition).join(', ')}) AS ${sql}`)
    .join('\n');

/** A column by side when one side lacks it; any other change reads from the source to the target. */
function changeLine(change: ColumnDifference): string {
  if (change.change !== 'added' && change.change !== 'removed') return describeColumnChange(change);
  const side = change.change === 'added' ? 'target' : 'source';
  return `only in the ${side}: ${inlineCode(change.path.join('.'))} (${inlineCode(change.type)})`;
}

function tableLines(differences: TableDifferences): string[] {
  const layout = (what: string, change: TableDifferences['partitioning']): string[] =>
    change
      ? [`- ${what}: ${valueOrNone(change.from)} in the source, ${valueOrNone(change.to)} in the target`]
      : [];
  return [
    ...capped(
      differences.columns.map((change) => `- ${changeLine(change)}`),
      LIMITS.changes,
    ),
    ...(differences.comment ? ['- table comment changed'] : []),
    ...layout('partitioning', differences.partitioning),
    ...layout('sort order', differences.sortOrder),
    ...(mayHideRename(differences) ? ['', RENAME_NOTE] : []),
  ];
}

/** Both texts of a view or macro that differs, each cut when it is long. */
const textLines = <T>(pair: Paired<T>, text: (item: T) => string): string[] => [
  'Left:',
  '',
  codeBlock(cut(text(pair.left)), 'sql'),
  '',
  'Right:',
  '',
  codeBlock(cut(text(pair.right)), 'sql'),
];

function differentSection({ tables, views, macros }: SchemaComparison): string[] {
  const sections = [
    ...tables.different.map(({ right, differences }) => [
      `### table ${inlineCode(right.name)}`,
      '',
      ...tableLines(differences),
    ]),
    ...views.different.map((pair) => [
      `### view ${inlineCode(pair.right.name)}`,
      '',
      ...textLines(pair, viewText),
    ]),
    ...macros.different.map((pair) => [
      `### ${macroKind(pair.right)} ${inlineCode(pair.right.name)}`,
      '',
      ...textLines(pair, macroText),
    ]),
  ];
  const shown = sections.slice(0, LIMITS.entries);
  return [
    `## Different (${sections.length})`,
    '',
    ...(shown.length === 0 ? ['None.', ''] : shown.flatMap((lines) => [...lines, ''])),
    ...(sections.length > shown.length ? [`… ${sections.length - shown.length} more omitted`, ''] : []),
  ];
}

function onlySection({ tables, views, macros }: SchemaComparison, side: 'onlyLeft' | 'onlyRight'): string[] {
  const lines = [
    ...tables[side].map(({ name }) => `- table ${inlineCode(name)}`),
    ...views[side].map(({ name }) => `- view ${inlineCode(name)}`),
    ...macros[side].map((macro) => `- ${macroKind(macro)} ${inlineCode(macro.name)}`),
  ];
  return [
    `## Only in the ${side === 'onlyLeft' ? 'source' : 'target'} (${lines.length})`,
    '',
    ...(lines.length === 0 ? ['None.'] : capped(lines, LIMITS.entries)),
    '',
  ];
}

const omittedText = (omitted: number): string =>
  `${plural(omitted, 'table')} in both ${omitted === 1 ? 'was' : 'were'} not compared (limit: ${LIMITS.tables}).`;

/** The Markdown report of two schemas; catalog text renders as code, lists and texts are cut at the limits. */
export function schemaReport(left: SchemaSide, right: SchemaSide, comparison: SchemaComparison): string {
  const { tables, views, macros } = comparison;
  const row = (label: string, kind: Counted): string[] => [
    label,
    ...[kind.onlyLeft.length, kind.onlyRight.length, kind.different.length, kind.equal].map(String),
  ];
  // The names show literally, on one line.
  const title = (side: SchemaSide): string =>
    `${markdownText(sideName(side, side.schemaName))} @${side.snapshot}`;
  return [
    `# Schema Compare: ${title(left)} ↔ ${title(right)}`,
    '',
    `- Left (source): ${title(left)}`,
    `- Right (target): ${title(right)}`,
    '',
    'Script as Update makes the target (right) like the source (left). A value that differs reads from the source to the target.',
    '',
    ...markdownTable(
      ['', 'Only in the source', 'Only in the target', 'In both, different', 'In both, equal'],
      [row('Tables', tables), row('Views', views), row('Macros', macros)],
    ),
    '',
    ...(tables.omitted > 0 ? [omittedText(tables.omitted), ''] : []),
    ...onlySection(comparison, 'onlyLeft'),
    ...onlySection(comparison, 'onlyRight'),
    ...differentSection(comparison),
  ].join('\n');
}

/** The information message: what differs, by side (source and target), or that nothing does. */
export function schemaSummary(comparison: SchemaComparison): string {
  const kinds: readonly (readonly [Counted, string])[] = [
    [comparison.tables, 'table'],
    [comparison.views, 'view'],
    [comparison.macros, 'macro'],
  ];
  const counted = (count: (kind: Counted) => number): string[] =>
    kinds.flatMap(([kind, noun]) => (count(kind) > 0 ? [plural(count(kind), noun)] : []));
  const onlyLeft = counted((kind) => kind.onlyLeft.length);
  const onlyRight = counted((kind) => kind.onlyRight.length);
  const different = counted((kind) => kind.different.length);
  const changed = kinds.reduce((sum, [kind]) => sum + kind.different.length, 0);
  const equal = plural(
    kinds.reduce((sum, [kind]) => sum + kind.equal, 0),
    'object',
  );
  const omitted = comparison.tables.omitted > 0 ? ` ${omittedText(comparison.tables.omitted)}` : '';
  if (!differs(comparison)) {
    return `The two schemas do not differ: ${equal} equal.${omitted}`;
  }
  const parts = [
    ...(onlyLeft.length > 0 ? [`${listed(onlyLeft)} only in the source`] : []),
    ...(onlyRight.length > 0 ? [`${listed(onlyRight)} only in the target`] : []),
    ...(different.length > 0 ? [`${listed(different)} ${changed === 1 ? 'differs' : 'differ'}`] : []),
    `${equal} equal`,
  ];
  return `The schemas differ: ${parts.join('; ')}.${omitted}`;
}
