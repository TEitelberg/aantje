/// <reference lib="dom" />
// Browser side of Suggest Partitioning; DOM only, the figures come from model.ts.
import {
  actionButton,
  cardGrid,
  dataTable,
  empty,
  findingCard,
  note,
  pageHeader,
  tableRow,
} from '../shell/blocks';
import { el } from '../shell/dom';
import { count, formatBytes } from '../shell/model';
import { reportPage } from '../shell/report-page';
import { readTheme, severityColor } from '../shell/theme';
import { figuresText, historyText, measureText, partitionHeading } from './model';
import type { Candidate, PartitionData } from './model';
import { isPartitionMessage } from './protocol';

function cards(data: PartitionData) {
  const { table, current, history } = data;
  return [
    { label: 'Rows', value: count(table.rows), severity: 'ok' as const },
    {
      label: 'Size',
      value: formatBytes(table.sizeBytes),
      detail: `${count(table.files)} files`,
      severity: 'ok' as const,
    },
    { label: 'Partitioning', value: current.partitioning ?? 'none', severity: 'ok' as const },
    { label: 'Sort order', value: current.sortOrder ?? 'none', severity: 'ok' as const },
    { label: 'Target file size', value: formatBytes(data.targetFileBytes), severity: 'ok' as const },
    {
      label: 'Queries of the table',
      value: count(history.tableQueries),
      detail: `of ${count(history.statements)} statements in your history`,
      severity: 'ok' as const,
    },
  ];
}

const number = (value: number): HTMLElement => el('td', 'number', count(value));

export const partitionPage = reportPage<PartitionData>(
  'partitioning',
  isPartitionMessage,
  ({ context, mount }) => {
    let data: PartitionData;

    const act = (action: string, candidate?: number): void =>
      context.post({ type: 'action', action, ...(candidate === undefined ? {} : { candidate }) });

    function candidateCard(candidate: Candidate, at: number): HTMLElement {
      return findingCard({
        severity: candidate.risks.length > 0 ? 'warning' : 'ok',
        title: `${at + 1}. ${candidate.keys.join(', ')}`,
        body: [
          figuresText(candidate),
          ...candidate.reasons,
          ...candidate.risks.map((risk) => `Risk: ${risk}`),
        ],
        actions: [
          actionButton(
            'Open Script',
            () => act('openScript', at),
            'Open the script of this partitioning in a SQL document: a dry run, then the partitioning and the rewrite, commented out; nothing runs',
          ),
        ],
      });
    }

    function render(): void {
      const { table, sortOrder } = data;
      const header = pageHeader(context, {
        title: partitionHeading(table),
        subtitle: `${table.schema}.${table.name} · ${data.connection} · @${table.snapshot}`,
        refresh: 'Read the history and measure the data again',
        actions: [
          actionButton(
            'Show Statistics',
            () => act('showStatistics'),
            `Show the statistics of ${table.schema}.${table.name}`,
          ),
        ],
      });
      const main = el('main');
      main.append(
        cardGrid(cards(data), severityColor(readTheme())),
        note(historyText(data)),
        ...(data.measureError === undefined
          ? []
          : [note(`The data could not be measured: ${data.measureError}`, 'warning')]),
        el('h2', undefined, 'Candidates'),
        ...(data.candidates.length === 0
          ? [empty('No partitioning fits the data and the filters.')]
          : data.candidates.map(candidateCard)),
        ...(sortOrder
          ? [
              el('h2', undefined, 'Sort order instead'),
              findingCard({
                severity: 'ok',
                title: sortOrder.column,
                body: [sortOrder.reason],
                actions: [
                  actionButton(
                    'Open Sort Order Script',
                    () => act('sortScript'),
                    `Open the script that sorts the table by ${sortOrder.column} in a SQL document; nothing runs`,
                  ),
                ],
              }),
            ]
          : []),
        ...(data.filters.length === 0
          ? []
          : [
              el('h2', undefined, 'Columns in filters'),
              dataTable(
                ['Column', 'Queries', 'Equality', 'Range', 'Join', 'Other'],
                data.filters.map(({ column, use }) =>
                  tableRow([
                    el('td', 'name', column),
                    number(use.queries),
                    number(use.equality),
                    number(use.range),
                    number(use.join),
                    number(use.other),
                  ]),
                ),
              ),
            ]),
        ...(data.measures.length === 0
          ? []
          : [
              el('h2', undefined, 'Measured columns'),
              dataTable(
                ['Column', 'Type', 'Measured'],
                data.measures.map((measure) =>
                  tableRow([el('td', 'name', measure.column), measure.type, measureText(measure)]),
                ),
              ),
            ]),
      );
      mount(header, main);
    }

    return {
      show(next) {
        data = next;
        render();
      },
      redraw: render,
    };
  },
);
