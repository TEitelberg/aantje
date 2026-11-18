/// <reference lib="dom" />
// Browser side of the Parquet inspector; DOM only, the figures come from model.ts.
import { isShape, isString } from '../guards';
import { actionButton, cardGrid, dataTable, note, pageHeader, tableRow, toolbar } from '../shell/blocks';
import { el } from '../shell/dom';
import { count, formatBytes } from '../shell/model';
import { reportPage } from '../shell/report-page';
import { readTheme, severityColor } from '../shell/theme';
import {
  FILE_GROUP_LABEL,
  fileFacts,
  fileName,
  overlapShare,
  overlapText,
  parquetCards,
  parquetHeading,
  rangeLayout,
  stateText,
} from './model';
import type { ChunkStats, ParquetData } from './model';
import { isParquetMessage } from './protocol';
import type { ParquetView } from './protocol';

// The column chosen for the row groups, by its path: another file of the table that has it shows it too.
const isSaved = isShape({ column: isString }) as (value: unknown) => value is { readonly column: string };

/** The drop-down of the data files of the table that the pick offered; nothing for a file of the Files folder. */
function fileChoice(data: ParquetData, open: (file: number) => void): HTMLElement[] {
  const current = data.target.lake?.fileId;
  const files = data.files ?? [];
  if (current === undefined || files.length === 0) return [];
  const select = el('select', 'files');
  let group: { readonly name: string; readonly element: HTMLElement } | undefined;
  for (const { group: name, target } of files) {
    if (!target.lake) continue;
    if (group?.name !== name) {
      const element = el('optgroup');
      element.label = FILE_GROUP_LABEL[name];
      select.append(element);
      group = { name, element };
    }
    const option = el('option', undefined, `${fileName(target.path)} · ${fileFacts(target.lake)}`);
    option.value = String(target.lake.fileId);
    group.element.append(option);
  }
  select.value = String(current);
  select.addEventListener('change', () => open(Number(select.value)));
  const label = el('label');
  label.append('Data file ', select);
  return [toolbar(label)];
}

const numberCell = (
  value: number | null | undefined,
  format: (value: number) => string = count,
): HTMLElement => el('td', 'number', value === null || value === undefined ? '' : format(value));

function rangeCell(range: { readonly from: number; readonly to: number } | undefined): HTMLElement {
  const cell = el('td', 'range');
  if (range) {
    const track = el('div', 'range-track');
    const bar = el('div', 'range-bar');
    bar.style.left = `${(range.from * 100).toFixed(1)}%`;
    bar.style.width = `${((range.to - range.from) * 100).toFixed(1)}%`;
    track.append(bar);
    cell.append(track);
  }
  return cell;
}

function rowGroupTable(data: ParquetData, column: number): HTMLElement {
  const stats = data.rowGroups.map(
    (group): ChunkStats => group.stats[column] ?? { min: null, max: null, nulls: null, distinct: null },
  );
  const layout = rangeLayout(stats);
  return dataTable(
    ['Row group', 'Rows', 'Compressed', 'Uncompressed', 'Range', 'Min', 'Max', 'Nulls', 'Distinct'],
    data.rowGroups.map((group, index) => {
      const chunk = stats[index];
      return tableRow([
        String(group.id),
        numberCell(group.rows),
        numberCell(group.compressedBytes, formatBytes),
        numberCell(group.uncompressedBytes, formatBytes),
        rangeCell(layout[index]),
        el('td', 'value', chunk?.min ?? ''),
        el('td', 'value', chunk?.max ?? ''),
        numberCell(chunk?.nulls),
        numberCell(chunk?.distinct),
      ]);
    }),
  );
}

export const parquetPage = reportPage<ParquetData>('parquet', isParquetMessage, ({ context, mount }) => {
  let data: ParquetData;
  let column = 0;
  const rowGroups = el('section', 'row-groups');

  // A file without columns (an encrypted lake, a failed read) keeps the column chosen before, for the next file.
  const save = (): void => {
    const path = data.columns[column]?.path;
    if (path !== undefined) context.state.set({ column: path });
  };
  // The page names a column by its index; the extension asks for the value of a probe itself.
  const act = (action: 'bloomProbe' | 'copy', index: number): void =>
    context.post({ type: 'action', action, ...{ column: index } });
  // Another data file is named by its id; the extension opens only a file of its list.
  const openFile = (file: number): void => context.post({ type: 'action', action: 'openFile', ...{ file } });

  function drawRowGroups(): void {
    if (data.rowGroups.length === 0 || data.columns.length === 0) {
      rowGroups.replaceChildren();
      return;
    }
    const select = el('select');
    for (const [index, entry] of data.columns.entries()) {
      const option = el('option', undefined, entry.path);
      option.value = String(index);
      select.append(option);
    }
    select.value = String(column);
    select.addEventListener('change', () => {
      column = Number(select.value);
      save();
      drawRowGroups();
    });
    const label = el('label');
    label.append('Column ', select);
    const stats = data.rowGroups.map(
      (group) => group.stats[column] ?? { min: null, max: null, nulls: null, distinct: null },
    );
    const total = data.file?.rowGroups ?? data.rowGroups.length;
    rowGroups.replaceChildren(
      el('h2', undefined, 'Row groups'),
      toolbar(label),
      note(overlapText(overlapShare(stats))),
      rowGroupTable(data, column),
      ...(total > data.rowGroups.length
        ? [
            note(
              `The file has ${count(total)} row groups; the first ${count(data.rowGroups.length)} were read.`,
            ),
          ]
        : []),
    );
  }

  function columnsTable(): HTMLElement {
    return dataTable(
      [
        'Column',
        'Physical',
        'Logical',
        'Compression',
        'Encodings',
        'Dictionary',
        'Bloom filter',
        'Field id',
        'DuckLake column',
        'Compressed',
        'Uncompressed',
        '',
      ],
      data.columns.map((entry, index) =>
        tableRow([
          el('td', 'name', entry.path),
          entry.physicalType ?? '',
          entry.logicalType ?? '',
          entry.compression,
          entry.encodings,
          entry.dictionary ? 'yes' : 'no',
          entry.bloomFilter ? 'yes' : 'no',
          entry.fieldId === null ? '' : String(entry.fieldId),
          entry.lakeColumn ?? '',
          numberCell(entry.compressedBytes, formatBytes),
          numberCell(entry.uncompressedBytes, formatBytes),
          entry.bloomFilter
            ? actionButton(
                'Probe',
                () => act('bloomProbe', index),
                `Ask the bloom filters of ${entry.path} whether a value you enter can be in each row group`,
              )
            : '',
        ]),
      ),
    );
  }

  function probeNote(): HTMLElement[] {
    const { probe, probeError } = data;
    if (probeError !== undefined)
      return [note(`The bloom filter could not be asked: ${probeError}`, 'warning')];
    const probed = probe && data.columns[probe.column];
    if (!probe || !probed) return [];
    return [
      note(
        `${JSON.stringify(probe.value)} in ${probed.path}: the bloom filters exclude ${count(probe.excluded.length)} of ${count(probe.rowGroups)} row groups${probe.excluded.length === 0 ? '' : ` (${probe.excluded.join(', ')})`}. A row group that is not excluded may hold the value.`,
      ),
    ];
  }

  function show(next: ParquetData): void {
    data = next;
    const saved = context.state.get();
    column = Math.max(
      0,
      next.columns.findIndex((entry) => isSaved(saved) && entry.path === saved.column),
    );
    const { lake } = next.target;
    const header = pageHeader(context, {
      title: parquetHeading(next),
      subtitle: `${next.name} · ${lake ? lake.table : 'Files'} · ${next.connection}`,
      refresh: 'Read the footer of the file again',
      view: (): ParquetView => ({ column }),
      actions: [
        actionButton('Copy', () => act('copy', column), 'Copy this report as Markdown to the clipboard'),
      ],
    });
    const state = stateText(next);
    const main = el('main');
    main.append(
      ...fileChoice(next, openFile),
      el('p', 'path', next.target.path),
      ...(lake
        ? [note(`Data file #${lake.fileId} of ${lake.table}, written at snapshot ${lake.beginSnapshot}.`)]
        : []),
      ...(state === undefined ? [] : [note(state, 'warning')]),
      cardGrid(parquetCards(next), severityColor(readTheme())),
      rowGroups,
      ...(next.columns.length === 0 ? [] : [el('h2', undefined, 'Columns'), columnsTable(), ...probeNote()]),
      ...(next.keyValues.length === 0
        ? []
        : [
            el('h2', undefined, 'Key/value metadata'),
            dataTable(
              ['Key', 'Value'],
              next.keyValues.map((entry) =>
                tableRow([el('td', 'name', entry.key), el('td', 'value', entry.value)]),
              ),
            ),
          ]),
    );
    mount(header, main);
    drawRowGroups();
    save();
  }

  // The colours of the cards follow the theme.
  return { show, redraw: () => show(data) };
});
