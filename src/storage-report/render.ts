/// <reference lib="dom" />
// DOM builders of the Storage page. They take the state they show and report user input through callbacks.
import { CLEANUP_OVERDUE_DAYS } from '../catalog/thresholds';
import { actionButton, cardGrid, dataTable, empty, note, tableRow, truncation } from '../shell/blocks';
import type { ChartOption } from '../shell/chart-option';
import { el } from '../shell/dom';
import { LIST_ROWS, count, formatBytes, plural, tableLabel } from '../shell/model';
import { severityColor } from '../shell/theme';
import type { Theme } from '../shell/theme';
import { statisticsGrowthOption } from '../stats/chart-options';
import { growthLabel, growthNotes, growthTime } from '../stats/model';
import {
  SCHEDULED_EXPLANATION,
  lastGrowth,
  matchingTables,
  rowsText,
  scheduledOf,
  expirableSentence,
  scheduledSentence,
  shareText,
  smallFilesText,
  sortedTables,
  storageCards,
} from './model';
import type { Sort, SortKey, StorageData } from './model';

/** The theme, and a chart box that the page draws once it is in the document. */
export interface Frame {
  readonly theme: Theme;
  readonly chartBox: (
    label: string,
    option: ChartOption,
    height?: number,
    onItemClick?: (index: number) => void,
  ) => HTMLElement;
}

export type Act = (action: string, table?: number) => void;

// The share has no sort key: it follows the size.
const COLUMNS: readonly { readonly label: string; readonly key?: SortKey; readonly number?: true }[] = [
  { label: 'Table', key: 'name' },
  { label: 'Files', key: 'files', number: true },
  { label: 'Size', key: 'size', number: true },
  { label: 'Share', number: true },
  { label: 'Rows', key: 'rows', number: true },
  { label: 'Small files', key: 'small' },
];

export function headerActions(act: Act): HTMLElement[] {
  return [
    actionButton(
      'Clean Up Old Files',
      () => act('scriptCleanup'),
      'Open the Clean Up Old Files script in a SQL document; it starts with a dry run and nothing runs',
    ),
    actionButton(
      'Expire Snapshots',
      () => act('scriptExpire'),
      'Open the Expire Snapshots script in a SQL document; it starts with a dry run and nothing runs',
    ),
    actionButton('Properties', () => act('showProperties'), 'Show the properties of the lake'),
  ];
}

export function overview(storage: StorageData, theme: Theme): HTMLElement[] {
  const scheduled = scheduledOf(storage);
  const sentence = scheduledSentence(storage);
  const section = el('div', scheduled.severity === 'warning' ? 'scheduled warning' : 'scheduled');
  section.append(
    el('p', undefined, scheduled.severity === 'warning' ? `⚠ ${sentence}` : sentence),
    ...(scheduled.severity === 'warning'
      ? [note(`That is longer than ${plural(CLEANUP_OVERDUE_DAYS, 'day', 'days')}.`, 'warning')]
      : []),
    note(SCHEDULED_EXPLANATION),
    ...(expirableSentence(storage) === '' ? [] : [el('p', undefined, expirableSentence(storage))]),
  );
  return [
    cardGrid(storageCards(storage), severityColor(theme)),
    note(
      'Counts cover data files and delete files. Rows that DuckLake keeps inline in the catalog are not included.',
    ),
    ...(storage.scope.kind === 'schema'
      ? [
          note(
            `The tables of the schema ${storage.scope.name}. The data path, the encryption, the files scheduled for deletion and the snapshots to expire are lake-wide.`,
          ),
        ]
      : []),
    el('h2', undefined, 'Files scheduled for deletion'),
    section,
  ];
}

export function selectionChildren(
  storage: StorageData,
  selected: number | undefined,
  act: Act,
): HTMLElement[] {
  const table = storage.tables.find((candidate) => candidate.id === selected);
  if (!table) {
    return [note('Select a table (its bar or its name) to see what you can do with it.')];
  }
  const name = tableLabel(table);
  const box = el('div', 'selection');
  const actions = el('div', 'actions');
  actions.append(
    actionButton('Show Statistics', () => act('showStatistics', table.id), `Show the statistics of ${name}`),
    actionButton('Show in Tree', () => act('revealTable', table.id), `Select ${name} in the tree`),
    actionButton(
      'Merge Adjacent Files',
      () => act('scriptMerge', table.id),
      `Open the script that merges the adjacent files of ${name} in a SQL document; nothing runs`,
    ),
    actionButton(
      'Rewrite Data Files',
      () => act('scriptRewrite', table.id),
      `Open the script that rewrites the data files of ${name} in a SQL document; nothing runs`,
    ),
  );
  box.append(
    el('h3', undefined, name),
    el(
      'p',
      undefined,
      `${plural(table.files, 'file', 'files')} · ${formatBytes(table.sizeBytes)} · ${shareText(table, storage)} of the ${storage.scope.kind === 'schema' ? 'schema' : 'lake'} · ${rowsText(table)} rows · small files: ${smallFilesText(table)}`,
    ),
    actions,
  );
  return [box];
}

interface TableList {
  readonly filter: string;
  readonly sort: Sort;
  readonly selected: number | undefined;
}

interface TableListHandlers {
  readonly onSort: (key: SortKey) => void;
  readonly onPick: (id: number) => void;
}

function headingCell(
  column: (typeof COLUMNS)[number],
  sort: Sort,
  onSort: (key: SortKey) => void,
  buttons: Map<SortKey, HTMLElement>,
): HTMLTableCellElement {
  const th = el('th', column.number ? 'number' : undefined);
  const { key } = column;
  if (key === undefined) {
    th.textContent = column.label;
    return th;
  }
  th.setAttribute('aria-sort', sort.key === key ? (sort.descending ? 'descending' : 'ascending') : 'none');
  const button = el('button', 'sort', column.label);
  button.addEventListener('click', () => onSort(key));
  buttons.set(key, button);
  th.append(button);
  return th;
}

/** The sortable table list; the buttons come back by table and sort key to restore the focus. */
export function tableListChildren(
  storage: StorageData,
  view: TableList,
  on: TableListHandlers,
): {
  readonly children: HTMLElement[];
  readonly rowButtons: ReadonlyMap<number, HTMLElement>;
  readonly headingButtons: ReadonlyMap<SortKey, HTMLElement>;
} {
  const { filter, sort, selected } = view;
  const rowButtons = new Map<number, HTMLElement>();
  const headingButtons = new Map<SortKey, HTMLElement>();
  const matching = sortedTables(matchingTables(storage.tables, filter), sort);
  const shown = matching.slice(0, LIST_ROWS);
  const headings = COLUMNS.map((column) => headingCell(column, sort, on.onSort, headingButtons));
  const rows = shown.map((table) => {
    const name = el('td', 'name');
    const pick = el('button', 'pick', tableLabel(table));
    pick.setAttribute('aria-pressed', String(table.id === selected));
    pick.addEventListener('click', () => on.onPick(table.id));
    rowButtons.set(table.id, pick);
    name.append(pick);
    const row = tableRow([
      name,
      ...[count(table.files), formatBytes(table.sizeBytes), shareText(table, storage), rowsText(table)].map(
        (text) => el('td', 'number', text),
      ),
      smallFilesText(table),
    ]);
    row.className = table.id === selected ? 'selected' : '';
    return row;
  });
  const children = [
    matching.length === 0 ? empty(`No table matches "${filter.trim()}".`) : dataTable(headings, rows),
    ...(matching.length > shown.length
      ? [truncation(shown.length, matching.length, 'tables', 'Type in the filter box to find the others.')]
      : []),
    ...(storage.tableCount > storage.tables.length
      ? [
          note(
            `${plural(storage.tableCount - storage.tables.length, 'smaller table is', 'smaller tables are')} not part of this report.`,
          ),
        ]
      : []),
  ];
  return { children, rowButtons, headingButtons };
}

export function growth(storage: StorageData, frame: Frame): HTMLElement[] {
  if (storage.growth.length === 0) {
    return [empty(`No data file was added or removed up to snapshot ${storage.snapshot}.`)];
  }
  const rows = lastGrowth(storage.growth).map((point) =>
    tableRow([
      growthLabel(point),
      growthTime(point),
      formatBytes(point.sizeBytes),
      count(point.files),
      point.compaction ? 'Compaction' : '',
    ]),
  );
  return [
    frame.chartBox(
      `Size and number of the files of ${storage.scope.kind === 'schema' ? `the schema ${storage.scope.name}` : 'the whole lake'} after each of ${count(storage.growth.length)} snapshots`,
      statisticsGrowthOption(storage, frame.theme.palette),
    ),
    ...growthNotes(storage).map((text) => note(text)),
    el('h2', undefined, `The last ${plural(rows.length, 'point', 'points')}`),
    dataTable(['Snapshot', 'Time', 'Size', 'Files', 'Note'], rows),
  ];
}
