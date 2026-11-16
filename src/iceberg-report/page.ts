/// <reference lib="dom" />
import {
  actionButton,
  cardGrid,
  dataTable,
  empty,
  pageHeader,
  searchBox,
  tableRow,
  toolbar,
} from '../shell/blocks';
import { el } from '../shell/dom';
import { formatUtc } from '../shell/model';
import { reportPage } from '../shell/report-page';
import { icebergCards, matchingRows, stateText, tableName } from './model';
import type { IcebergData, IcebergTableRow } from './model';
import { icebergLogo } from './logo';
import { isIcebergMessage } from './protocol';

const ACTION_LABEL = { copyAgain: 'Sync to Apache Iceberg', forget: 'Forget Sync' } as const;
const ACTION_HINT = {
  copyAgain:
    'Bring the Iceberg tables of this sync to the state of the lake: append what the lake inserted, replace what it changed',
  forget: "Forget aantje's record of this copy; the Iceberg tables stay in the catalog",
} as const;

function behind(row: IcebergTableRow): string {
  if (row.snapshotsBehind === 0) return '';
  const times = row.lakeChangedAt === null ? '' : `, last ${formatUtc(row.lakeChangedAt)}`;
  return `${row.snapshotsBehind} ${row.snapshotsBehind === 1 ? 'snapshot' : 'snapshots'}${times}`;
}

function icebergIds(row: IcebergTableRow): string {
  if (row.icebergRemembered === null && row.icebergCurrent === null) return '';
  return row.icebergRemembered === row.icebergCurrent
    ? (row.icebergCurrent ?? '')
    : `${row.icebergRemembered ?? 'none'} → ${row.icebergCurrent ?? 'none'}`;
}

function addedList(added: IcebergData['added']): HTMLElement {
  const list = el('ul');
  list.append(...added.map((table) => el('li', 'name', tableName(table))));
  return list;
}

export const icebergPage = reportPage<IcebergData>('iceberg', isIcebergMessage, ({ context, mount }) => {
  let data: IcebergData;
  let filter = '';
  const table = el('div', 'tables');

  function drawTable(): void {
    const matching = matchingRows(data.tables, filter);
    table.replaceChildren(
      matching.length === 0
        ? empty(data.tables.length === 0 ? 'No table was synced.' : `No table matches "${filter.trim()}".`)
        : dataTable(
            ['Table', 'State', 'Synced at', 'Lake changes since', 'Iceberg snapshot', 'Rows', 'Notes'],
            matching.map((row) => {
              const state = el(
                'td',
                row.problems.length === 0 ? 'state good' : 'state bad',
                stateText(row.problems),
              );
              state.title = row.checkError ?? '';
              return tableRow([
                el('td', 'name', tableName(row)),
                state,
                `@${row.copiedSnapshot}`,
                behind(row),
                el('td', 'ids', icebergIds(row)),
                row.rows === null ? '' : String(row.rows),
                row.checkError ?? row.converted.join('; '),
              ]);
            }),
          ),
    );
  }

  return {
    show(next) {
      data = next;
      const header = pageHeader(context, {
        title: 'Apache Iceberg Sync',
        logo: icebergLogo(32),
        subtitle: `${next.connection} → ${next.target.name} · copied ${next.copiedAt === '' ? 'never' : formatUtc(next.copiedAt)} · checked ${formatUtc(next.checkedAt)}`,
        refresh: 'Check the copy again against the lake and the Iceberg catalog',
        markdown: false,
        actions: next.actions.map((action) =>
          actionButton(
            ACTION_LABEL[action],
            () => context.post({ type: 'action', action }),
            ACTION_HINT[action],
          ),
        ),
      });
      const main = el('main');
      main.append(
        el(
          'p',
          next.inSync ? 'verdict good' : 'verdict bad',
          next.inSync
            ? `The copy has the state of the lake (@${next.newest}).`
            : next.icebergError === null
              ? 'The copy is out of sync with the lake or with the Iceberg catalog.'
              : `The copy could not be checked: ${next.icebergError}`,
        ),
        cardGrid(icebergCards(next), () => ''),
        el('h2', undefined, 'Tables'),
        toolbar(
          searchBox('Filter', filter, (text) => {
            filter = text;
            drawTable();
          }),
        ),
        table,
      );
      if (next.added.length > 0) {
        main.append(
          el('h2', undefined, 'New in the lake'),
          el('p', undefined, 'These tables are not in the copy. Sync to Apache Iceberg to add them.'),
          addedList(next.added),
        );
      }
      mount(header, main);
      drawTable();
    },
    redraw: () => undefined,
  };
});
