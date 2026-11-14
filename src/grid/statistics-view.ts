/// <reference lib="dom" />
// The tabs of a profile (Statistics): the operators as a table, indented as in the plan, with their own time and share;
// and the charts of them, which plan-client.js draws with ECharts.
import { count, secondsText } from '../shell/numbers';
import { el } from '../shell/dom';
import { estimateOf, operatorRows, profilePlan, profileSummary, shareText } from './plan';
import type { OperatorRow, Plan } from './plan';
import { lazyChartTab } from './result-tab';
import type { ResultTab } from './result-tab';
import type { ProfileView } from './results-model';

// The time of an operator adds up all threads that ran it (DuckDB's operator timing).
const COLUMNS = [
  'Operator',
  'Name',
  'Branch',
  'Self time (all threads)',
  'Share',
  'Rows',
  'Estimated',
  'Details',
] as const;

const estimateText = (row: OperatorRow): string => {
  const value = estimateOf(row.node);
  return row.node.estimated === undefined ? '–' : value === undefined ? row.node.estimated : count(value);
};

/** The cells of a row as text, in the order of the columns. */
function cells(row: OperatorRow): string[] {
  return [
    row.node.name,
    row.name,
    row.branch,
    row.seconds === undefined ? '' : secondsText(row.seconds),
    shareText(row.share),
    row.node.rows === undefined ? '' : count(row.node.rows),
    estimateText(row),
    row.details,
  ];
}

/** The table as tab-separated text with a header, for Copy. */
export function statisticsTsv(plan: Plan): string {
  const clean = (text: string): string => text.replace(/[\t\r\n]+/g, ' ');
  return [COLUMNS.join('\t'), ...operatorRows(plan).map((row) => cells(row).map(clean).join('\t'))].join(
    '\n',
  );
}

function statisticsTable(plan: Plan): HTMLElement {
  const table = el('table', 'statistics');
  const head = el('tr');
  for (const [index, column] of COLUMNS.entries())
    head.append(el('th', index >= 3 && index <= 6 ? 'num' : undefined, column));
  const thead = el('thead');
  thead.append(head);
  const body = el('tbody');
  for (const row of operatorRows(plan)) {
    const [operator = '', ...rest] = cells(row);
    const tr = el('tr');
    const first = el('td', 'op');
    first.style.paddingLeft = `${8 + row.depth * 12}px`;
    // The square has the colour of the operator's kind, as in the charts.
    first.append(el('span', `kind kind-${row.kind}`), el('span', undefined, operator));
    tr.append(first);
    rest.forEach((text, index) => {
      const cell = el('td', index >= 2 && index <= 5 ? 'num' : index === 6 ? 'details' : undefined, text);
      if (index === 6) cell.title = text;
      tr.append(cell);
    });
    body.append(tr);
  }
  table.append(thead, body);
  const scroll = el('div', 'statistics-scroll');
  scroll.append(table);
  return scroll;
}

/** A chart of a profile (Flame Graph, Treemap & Top Operators); without plan-client.js the table stands in for it. */
function chartTab(
  view: HTMLElement,
  plan: Plan,
  draw: 'drawFlame' | 'drawOperators',
  copy: HTMLElement,
): ResultTab {
  const host = el('div', draw === 'drawFlame' ? 'profile-chart flame' : 'profile-chart operators');
  view.append(copy, host);
  return lazyChartTab(
    view,
    host,
    (target) => window.aantjePlan?.[draw](target, plan),
    () => [statisticsTable(plan)],
  );
}

/**
 * One tab of a profile in `view`, which holds the statement already. `copyBar` makes the bar with the button that
 * copies the table as tab-separated text, the same in every view.
 */
export function profileView(
  view: HTMLElement,
  json: string,
  shown: ProfileView,
  copyBar: (text: string) => HTMLElement,
): ResultTab {
  const plan = profilePlan(json);
  if (!plan) {
    view.append(
      el('div', 'end', 'DuckDB wrote no operators into this profile. Text Statistics shows what it wrote.'),
    );
    return { elements: [view], placed: () => undefined };
  }
  const copy = copyBar(statisticsTsv(plan));
  if (shown === 'flame') return chartTab(view, plan, 'drawFlame', copy);
  if (shown === 'operators') return chartTab(view, plan, 'drawOperators', copy);
  view.append(el('div', 'summary', profileSummary(plan)), copy, statisticsTable(plan));
  return { elements: [view], placed: () => undefined };
}
