import { HEALTH_GROUPS } from '../health/model';
import type { FindingScope, HealthFinding, HealthSeverity } from '../health/model';
import { capRows, code, markdownTable, reportTitle } from '../markdown';
import { codeBlock } from '../markdown';
import { count } from '../shell/model';
import { formatDuration } from '../shell/numbers';
import {
  DEFAULT_FILTER,
  GROUP_LABEL,
  SEVERITIES,
  SEVERITY_LABEL,
  actionsOf,
  coverage,
  groupLine,
  matchingFindings,
  healthScopeLabel,
  lakeSectionLabel,
  sections,
  verdictText,
} from './model';
import type { HealthData, HealthFilter } from './model';

const MARKDOWN_FINDINGS = 200;

// Catalog names must not render: one line, no invisible characters, a backslash before every character that starts
// markup, before `:`, `//` and `www.` so that a data path is no link, before the `@` of `user@host` so that it is no mail link (`@6`, a snapshot, stays),
// and before a list marker or heading mark at the start. Underscores inside a word stay.
function prose(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim()
    .replace(/[\\`*<>[\]|~&]/g, '\\$&')
    .replace(/(?<=[\p{L}\p{N}._+-])@/gu, '\\@')
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_')
    .replace(/(:)?\/\//g, (_, colon: string | undefined) => `${colon ? '\\:' : ''}\\/\\/`)
    .replace(/\bwww\./gi, (www) => `${www.slice(0, 3)}\\.`)
    .replace(/^(?:[-+#]|\d{1,9}[.)])(?=\s|$)/, (mark) => mark.replace(/[-+#.)]/, '\\$&'));
}

const scopeText = (data: HealthData): string => {
  const { scope } = data;
  if (scope.kind === 'lake') return 'Lakehouse';
  if (scope.kind === 'schema')
    return `The tables of the schema ${code(scope.name)}; the Lakehouse findings are lake-wide`;
  return code(healthScopeLabel(scope));
};

// Actions that change the setup appear as hints only: the panel runs them.
const ACTION_HINT = {
  useEndpoint: 'Use suggested endpoint (writes the settings after you confirm)',
  setCredentials: 'Set S3 Credentials... (asks for the keys in a masked prompt)',
  editConnection: 'Edit Connection... (the storage of the connection)',
  setStorageSignIn: 'Set Storage Sign-in... (asks for the keys or tokens in a masked prompt)',
} as const;

const findingBlock = (finding: HealthFinding): string[] => [
  `**${prose(finding.title)}**`,
  '',
  `${code(finding.check)}, group ${GROUP_LABEL[finding.group]}`,
  '',
  `- Detail: ${prose(finding.detail)}`,
  `- Cause: ${prose(finding.cause)}`,
  `- Fix: ${prose(finding.fix)}`,
  ...(finding.objectKey === undefined ? [] : [`- Object: ${code(finding.objectKey)}`]),
  ...(finding.settingKey === undefined ? [] : [`- Setting: ${code(`aantje.${finding.settingKey}`)}`]),
  ...(finding.suggestion === undefined
    ? []
    : [
        `- Suggested endpoint: ${code(finding.suggestion.endpoint)} (from ${code(finding.suggestion.source)})${finding.suggestion.urlStyle ? `, URL style ${code(finding.suggestion.urlStyle)}` : ''}`,
      ]),
  ...actionsOf(finding).flatMap((id) =>
    id in ACTION_HINT ? [`- Action in the panel: ${ACTION_HINT[id as keyof typeof ACTION_HINT]}`] : [],
  ),
  ...(finding.inspectSql === undefined
    ? []
    : [
        '',
        'SQL to inspect it (run it in a SQL editor of the connection):',
        '',
        codeBlock(finding.inspectSql, 'sql'),
      ]),
  ...(finding.fixSql === undefined
    ? []
    : [
        '',
        'SQL to fix it (run it in a read/write SQL editor of the connection):',
        '',
        codeBlock(finding.fixSql, 'sql'),
      ]),
  '',
];

/** The health check as Markdown for the findings that match the filter of the view. Every catalog text is escaped. */
export function healthMarkdown(data: HealthData, view?: HealthFilter): string {
  const filter = view ?? DEFAULT_FILTER;
  const matching = matchingFindings(data.findings, filter);
  return [
    reportTitle(
      'Health check of',
      data.connection,
      data.scope.kind === 'schema' ? data.scope.name : undefined,
    ),
    '',
    verdictText(data),
    '',
    ...markdownTable(['Property', 'Value'], propertyRows(data)),
    '',
    '## Groups',
    '',
    ...markdownTable(['Group', 'State'], groupRows(data)),
    '',
    '## Findings',
    '',
    ...filterNote(data, filter, matching.length),
    ...(matching.length === 0
      ? [data.findings.length === 0 ? 'No findings.' : 'No finding matches the filter.', '']
      : []),
    ...findingSections(matching, data.scope),
    ...coverageSection(data),
  ]
    .join('\n')
    .trimEnd()
    .concat('\n');
}

function propertyRows(data: HealthData): string[][] {
  const { summary } = data;
  return [
    ['Scope', scopeText(data)],
    [
      'Depth',
      data.depth === 'deep' ? `Deep check, up to ${count(data.deepFiles)} files` : 'Quick + existence',
    ],
    ['Checked snapshot', data.snapshot === undefined ? 'not read' : `@${data.snapshot}`],
    ...(summary
      ? [
          ['Errors', count(summary.errors)],
          ['Warnings', count(summary.warnings)],
          ['Infos', count(summary.infos)],
          ['Duration', formatDuration(summary.elapsedMs)],
        ]
      : []),
  ];
}

const groupRows = (data: HealthData): string[][] =>
  HEALTH_GROUPS.map((group) => [
    GROUP_LABEL[group],
    prose(
      groupLine(
        data.groups.find((status) => status.group === group),
        undefined,
      ),
    ),
  ]);

function filterNote(data: HealthData, filter: HealthFilter, matches: number): string[] {
  const text = filter.text.trim();
  const filtered =
    text !== '' ||
    filter.severities.length !== DEFAULT_FILTER.severities.length ||
    filter.groups.length !== DEFAULT_FILTER.groups.length;
  if (!filtered) return [];
  const severities = filter.severities.map((severity) => SEVERITY_LABEL[severity]).join(', ');
  const groups = filter.groups.map((group) => GROUP_LABEL[group]).join(', ');
  return [
    `Filter: ${text === '' ? 'no text' : code(text)}; ${severities || 'no severity'}; ${groups || 'no group'}. ${matches} of ${data.findings.length} findings match.`,
    '',
  ];
}

function findingSections(matching: readonly HealthFinding[], reportScope: FindingScope): string[] {
  const bySeverity = (severity: HealthSeverity): HealthFinding[] =>
    matching.filter((finding) => finding.severity === severity);
  const { shown, omitted } = capRows(
    SEVERITIES.flatMap((severity) => bySeverity(severity)),
    MARKDOWN_FINDINGS,
  );
  const listed = new Set(shown);
  return [
    ...SEVERITIES.flatMap((severity) => {
      const list = bySeverity(severity).filter((finding) => listed.has(finding));
      return list.length === 0
        ? []
        : [
            `### ${SEVERITY_LABEL[severity]}s (${bySeverity(severity).length})`,
            '',
            ...sections(list, lakeSectionLabel(reportScope)).flatMap((section) => [
              `#### ${section.findings[0]?.scope.kind === 'lake' ? section.label : code(section.label)}`,
              '',
              ...section.findings.flatMap(findingBlock),
            ]),
          ];
    }),
    ...omitted.flatMap((line) => (line === '' ? [line] : [line, ''])),
  ];
}

function coverageSection(data: HealthData): string[] {
  const { checked, notChecked } = coverage(data);
  if (checked.length === 0 && notChecked.length === 0) return [];
  return [
    '## What was checked',
    '',
    ...checked.map((text) => `- Checked ${text}.`),
    ...notChecked.map((text) => `- Not checked: ${prose(text)}`),
    '',
  ];
}
