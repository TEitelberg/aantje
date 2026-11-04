/// <reference lib="dom" />
// DOM builders of the Health page. They take the state they show and report user input through callbacks.
import { HEALTH_GROUPS } from '../health/model';
import type { HealthFinding } from '../health/model';
import { actionButton, cardGrid, empty, note, pageHeader, searchBox, truncation } from '../shell/blocks';
import type { Header } from '../shell/blocks';
import { el } from '../shell/dom';
import type { Severity } from '../shell/model';
import type { PageContext } from '../shell/page';
import type { Theme } from '../shell/theme';
import {
  GROUP_LABEL,
  MAX_DEEP_FILES,
  SEVERITIES,
  SEVERITY_LABEL,
  SEVERITY_SIGN,
  actionsOf,
  counts,
  coverage,
  groupLine,
  hasMaintenanceScript,
  healthCards,
  matchingFindings,
  healthScopeLabel,
  lakeSectionLabel,
  healthScriptOf,
  sections,
  verdict,
  verdictText,
} from './model';
import type { FindingActionId, HealthData, HealthFilter } from './model';

type Depth = 'quick' | 'deep';

interface HeaderView {
  readonly data: HealthData;
  /** What Open as Markdown carries: the filter as it is when the button is pressed. */
  readonly filter: () => HealthFilter;
  readonly depth: Depth;
  readonly deepFiles: number;
  /** The number of files is not a whole number in range. */
  readonly invalid: boolean;
}

interface HeaderHandlers {
  readonly onRun: () => void;
  readonly onCancel: (button: HTMLButtonElement) => void;
  readonly onScript: () => void;
  readonly onDepth: (depth: Depth) => void;
  readonly onFiles: (count: number) => void;
}

interface HeaderParts {
  readonly top: Header;
  readonly depthBar: HTMLElement;
  readonly run: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
}

/** The title, the run controls and the depth choice. */
export function headerParts(context: PageContext, view: HeaderView, on: HeaderHandlers): HeaderParts {
  const { data } = view;
  const running = data.status === 'running';
  const run = actionButton(
    data.status === 'idle' || data.status === 'running' ? 'Run' : 'Run again',
    on.onRun,
    'Run the health check with the chosen depth. It only reads; it changes nothing.',
  );
  run.className = 'primary';
  run.disabled = running;
  const cancel = actionButton(
    'Cancel',
    () => on.onCancel(cancel),
    'Stop the running check; what it has found so far stays',
  );
  const script = actionButton(
    'Create maintenance script for all findings',
    on.onScript,
    'Open one SQL document with the fix of every finding that maintenance can fix. Nothing runs; destructive calls start as a dry run.',
  );
  script.disabled = running || !hasMaintenanceScript(data.findings);
  const snapshot = data.snapshot === undefined ? '' : ` · checked snapshot @${data.snapshot}`;
  const top = pageHeader(context, {
    title: 'Health check',
    subtitle: `${healthScopeLabel(data.scope)} · ${data.connection}${snapshot}`,
    view: view.filter,
    actions: [run, script, ...(running ? [cancel] : [])],
  });
  return { top, depthBar: depthBar(view, on), run, cancel };
}

function depthBar(view: HeaderView, on: HeaderHandlers): HTMLElement {
  const running = view.data.status === 'running';
  const bar = el('div', 'run');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Depth of the check');
  const mode = (id: Depth, label: string, description: string): HTMLButtonElement => {
    const button = actionButton(label, () => on.onDepth(id), description);
    button.className = 'mode';
    button.setAttribute('aria-pressed', String(view.depth === id));
    button.disabled = running;
    return button;
  };
  bar.append(
    mode('quick', 'Quick + existence', 'Read the catalog and list the files in the store; no file is opened'),
    mode(
      'deep',
      'Deep check',
      'Also read the Parquet footers of the files: the row count and the columns against the catalog',
    ),
  );
  if (view.depth === 'deep') bar.append(filesInput(view, on.onFiles));
  if (view.invalid) {
    bar.append(note(`Enter a whole number from 1 to ${MAX_DEEP_FILES.toLocaleString('en-US')}.`, 'warning'));
  }
  return bar;
}

function filesInput(view: HeaderView, onFiles: (count: number) => void): HTMLElement {
  const label = el('label');
  const input = el('input');
  input.type = 'number';
  input.min = '1';
  input.max = String(MAX_DEEP_FILES);
  input.value = String(view.deepFiles);
  input.disabled = view.data.status === 'running';
  input.setAttribute('aria-label', 'Number of files to open');
  input.setAttribute('aria-invalid', String(view.invalid));
  input.addEventListener('input', () => {
    input.setAttribute('aria-invalid', 'false');
    onFiles(Number(input.value));
  });
  label.append('Files ', input);
  return label;
}

/** The verdict, the state of the groups and, after a run, what was and was not checked. */
export function statusChildren(data: HealthData, theme: Theme): HTMLElement[] {
  if (data.status === 'idle') {
    const what = data.scope.kind === 'lake' ? 'the lakehouse' : healthScopeLabel(data.scope).toLowerCase();
    return [
      note(
        `Press Run to check ${what}. The quick check reads the catalog and lists the files in the store without opening one; the deep check also reads the Parquet footers. The check only reads and changes nothing.`,
      ),
    ];
  }
  const colorOf = (severity: Severity): string =>
    severity === 'error'
      ? theme.palette.error
      : severity === 'warning'
        ? theme.palette.warning
        : theme.palette.series[0];
  return [
    ...(data.summary ? [cardGrid(healthCards(data), colorOf)] : []),
    el('p', `verdict ${verdict(data)}`, verdictText(data)),
    groupList(data),
    ...(data.status === 'done' || data.status === 'cancelled' ? [coverageBox(data)] : []),
  ];
}

function groupList(data: HealthData): HTMLElement {
  const list = el('ul', 'groups');
  for (const group of HEALTH_GROUPS) {
    const known = data.groups.find((candidate) => candidate.group === group);
    const item = el('li');
    item.append(
      el('span', 'group-name', GROUP_LABEL[group]),
      el('span', undefined, groupLine(known, data.progress)),
    );
    list.append(item);
  }
  return list;
}

function coverageBox(data: HealthData): HTMLElement {
  const { checked, notChecked } = coverage(data);
  const box = el('div', 'coverage');
  const section = (heading: string, lines: readonly string[]): void => {
    const ul = el('ul');
    ul.append(...lines.map((line) => el('li', undefined, line)));
    box.append(el('h3', undefined, heading), ul);
  };
  if (checked.length > 0)
    section(
      'What was checked',
      checked.map((line) => `Checked ${line}.`),
    );
  if (notChecked.length > 0) section('What was not checked', notChecked);
  return box;
}

interface FilterHandlers {
  readonly onSeverity: (severity: (typeof SEVERITIES)[number]) => void;
  readonly onGroup: (group: (typeof HEALTH_GROUPS)[number]) => void;
  readonly onText: (text: string) => void;
}

/** The filter bar; `buttons` receives the toggle buttons by key so that `markFilters` and `countFilters` can reach them. */
export function filterBar(
  filter: HealthFilter,
  buttons: Map<string, HTMLElement>,
  on: FilterHandlers,
): HTMLElement {
  buttons.clear();
  const set = (label: string): HTMLElement => {
    const box = el('span', 'set');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', label);
    box.append(el('span', 'set-label', label));
    return box;
  };
  const toggle = (key: string, label: string, onClick: () => void, into: HTMLElement): void => {
    const button = actionButton(label, onClick);
    button.className = 'mode';
    buttons.set(key, button);
    into.append(button);
  };
  const severities = set('Severity');
  for (const severity of SEVERITIES) {
    toggle(`severity:${severity}`, SEVERITY_LABEL[severity], () => on.onSeverity(severity), severities);
  }
  const groups = set('Group');
  for (const group of HEALTH_GROUPS) {
    toggle(`group:${group}`, GROUP_LABEL[group], () => on.onGroup(group), groups);
  }
  const bar = el('div', 'filters');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Filters');
  bar.append(severities, groups, searchBox('Filter', filter.text, on.onText));
  return bar;
}

/** The state of the toggle buttons. */
export function markFilters(buttons: ReadonlyMap<string, HTMLElement>, filter: HealthFilter): void {
  for (const severity of SEVERITIES) {
    buttons
      .get(`severity:${severity}`)
      ?.setAttribute('aria-pressed', String(filter.severities.includes(severity)));
  }
  for (const group of HEALTH_GROUPS) {
    buttons.get(`group:${group}`)?.setAttribute('aria-pressed', String(filter.groups.includes(group)));
  }
}

/** The numbers on the buttons change with every finding; the buttons themselves stay, so the focus does too. */
export function countFilters(
  buttons: ReadonlyMap<string, HTMLElement>,
  findings: readonly HealthFinding[],
): void {
  const total = counts(findings);
  for (const severity of SEVERITIES) {
    const button = buttons.get(`severity:${severity}`);
    if (button) button.textContent = `${SEVERITY_LABEL[severity]} (${total.severity[severity]})`;
  }
  for (const group of HEALTH_GROUPS) {
    const button = buttons.get(`group:${group}`);
    if (button) button.textContent = `${GROUP_LABEL[group]} (${total.group[group]})`;
  }
}

interface ListView {
  readonly data: HealthData;
  readonly filter: HealthFilter;
  /** How many findings are shown before "Show more". */
  readonly limit: number;
  readonly expanded: ReadonlySet<string>;
}

interface ListHandlers {
  readonly onToggle: (id: string, open: boolean) => void;
  readonly onAction: (action: string, finding: string) => void;
  readonly onMore: () => void;
}

/** The findings that match the filter, in sections, cut at the limit. */
export function listChildren(view: ListView, on: ListHandlers): HTMLElement[] {
  const { data, limit } = view;
  if (data.findings.length === 0) return [];
  const matching = matchingFindings(data.findings, view.filter);
  if (matching.length === 0) return [empty('No finding matches the filters.')];
  const running = data.status === 'running';
  const children: HTMLElement[] = [];
  let room = limit;
  for (const section of sections(matching, lakeSectionLabel(data.scope))) {
    if (room <= 0) break;
    const shown = section.findings.slice(0, room);
    room -= shown.length;
    children.push(
      el('h2', undefined, `${section.label} (${section.findings.length})`),
      ...shown.map((finding) => findingCard(finding, view.expanded.has(finding.id), running, on)),
    );
  }
  if (matching.length > limit) {
    children.push(
      truncation(limit, matching.length, 'findings', 'The list is cut to keep the page quick.'),
      actionButton('Show more', on.onMore),
    );
  }
  return children;
}

function findingCard(finding: HealthFinding, open: boolean, running: boolean, on: ListHandlers): HTMLElement {
  const { severity } = finding;
  const details = el('details', `health-finding ${severity}`);
  details.open = open;
  details.addEventListener('toggle', () => on.onToggle(finding.id, details.open));
  const summary = el('summary');
  summary.append(
    el('span', 'sev', `${SEVERITY_SIGN[severity]} ${SEVERITY_LABEL[severity]}`),
    ' ',
    el('span', 'title', finding.title),
  );
  const body = el('div', 'body');
  body.append(findingTerms(finding));
  if (finding.inspectSql !== undefined) {
    const pre = el('pre');
    pre.append(el('code', undefined, finding.inspectSql));
    body.append(el('dt', undefined, 'SQL to inspect it'), pre);
  }
  if (finding.fixSql !== undefined) {
    const pre = el('pre');
    pre.append(el('code', undefined, finding.fixSql));
    body.append(el('dt', undefined, 'SQL to fix it'), pre);
  }
  const actions = actionButtons(finding, running, on.onAction);
  if (actions.length > 0) {
    const box = el('div', 'actions');
    box.append(...actions);
    body.append(box);
  }
  details.append(summary, body);
  return details;
}

function findingTerms(finding: HealthFinding): HTMLElement {
  const terms = el('dl');
  const row = (term: string, text: string, code = false): void => {
    terms.append(el('dt', undefined, term));
    const definition = el('dd');
    definition.append(code ? el('code', undefined, text) : text);
    terms.append(definition);
  };
  row('What was found', finding.detail);
  row('Likely cause', finding.cause);
  row('What to do', finding.fix);
  if (finding.objectKey !== undefined) row('File or key', finding.objectKey, true);
  if (finding.settingKey !== undefined) row('Setting', `aantje.${finding.settingKey}`, true);
  row('Check', `${finding.check} (${GROUP_LABEL[finding.group]})`, true);
  return terms;
}

function actionButtons(
  finding: HealthFinding,
  running: boolean,
  act: (action: string, finding: string) => void,
): HTMLElement[] {
  const script = healthScriptOf(finding);
  // These two change the setup the run reads, so they wait for the run to end.
  const idle = (button: HTMLButtonElement): HTMLButtonElement => {
    button.disabled = running;
    return button;
  };
  const names: Record<FindingActionId, () => HTMLElement> = {
    inspect: () =>
      actionButton(
        'Open SQL to inspect',
        () => act('inspect', finding.id),
        'Open the SQL that shows the evidence in a new SQL editor of this connection; it is not run',
      ),
    setting: () =>
      actionButton(
        'Open setting',
        () => act('setting', finding.id),
        `Open the setting aantje.${finding.settingKey ?? ''} in the settings`,
      ),
    useEndpoint: () => {
      const { endpoint = '', urlStyle } = finding.suggestion ?? {};
      return idle(
        actionButton(
          'Use suggested endpoint',
          () => act('useEndpoint', finding.id),
          `After you confirm, write aantje.s3.endpoint = ${endpoint}${urlStyle ? ` and aantje.s3.urlStyle = ${urlStyle}` : ''} into your user settings, then run the quick check again`,
        ),
      );
    },
    setCredentials: () =>
      idle(
        actionButton(
          'Set S3 Credentials...',
          () => act('setCredentials', finding.id),
          'Run "aantje: Set S3 Credentials...": it asks for the key id and the secret in its own masked prompts, and the quick check runs again afterwards. This page never sees the keys',
        ),
      ),
    script: () =>
      actionButton(
        script?.label ?? '',
        () => act('script', finding.id),
        `Open the ${script?.label ?? ''} script in a SQL editor of this connection; nothing runs${script?.warning ? `. ${script.warning}` : ''}`,
      ),
    revealTable: () =>
      actionButton(
        'Show table in tree',
        () => act('revealTable', finding.id),
        'Select the table in the tree',
      ),
    showStatistics: () =>
      actionButton(
        'Show Statistics',
        () => act('showStatistics', finding.id),
        'Show the statistics report of the table',
      ),
  };
  return actionsOf(finding).map((id) => names[id]());
}

/** The four stacked regions of the page. */
export function pageRegions(): {
  header: HTMLElement;
  status: HTMLElement;
  filters: HTMLElement;
  list: HTMLElement;
} {
  const regions = { header: el('div'), status: el('div'), filters: el('div'), list: el('div') };
  regions.status.setAttribute('role', 'status');
  return regions;
}

/** Focuses the button that the user just replaced; returns what is still wanted. */
export function settleFocus(
  wanted: 'run' | 'cancel' | undefined,
  running: boolean,
  parts: HeaderParts,
): 'run' | 'cancel' | undefined {
  if (wanted === 'cancel' && running) {
    parts.cancel.focus();
    return undefined;
  }
  if (wanted === 'run' && !running) {
    parts.run.focus();
    return undefined;
  }
  return wanted;
}
