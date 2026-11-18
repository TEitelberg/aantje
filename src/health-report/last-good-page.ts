/// <reference lib="dom" />
// Browser side of Find Last Good Snapshot; DOM only, the texts come from last-good.ts.
import { actionButton, dataTable, note, pageHeader, tableRow } from '../shell/blocks';
import { el } from '../shell/dom';
import { reportPage } from '../shell/report-page';
import { RESTORE_NOTE, badLines, filesNote, isLastGoodMessage, snapshotText, verdictText } from './last-good';
import type { LastGoodData } from './last-good';
import { healthScopeLabel, lastGoodHeading } from './model';

export const lastGoodPage = reportPage<LastGoodData>('lastGood', isLastGoodMessage, ({ context, mount }) => {
  let data: LastGoodData;

  const act = (action: string, table?: number): void =>
    context.post({ type: 'action', action, ...(table === undefined ? {} : { table }) });

  function badSection(): HTMLElement[] {
    const bad = data.result.firstBad;
    if (!bad) return [];
    const files = el('ul', 'files');
    for (const file of bad.files) {
      files.append(
        el(
          'li',
          undefined,
          `${file.problem === 'missing' ? 'Missing' : 'Other size'}: ${file.kind} file #${file.id}${file.table === null ? '' : ` of ${file.table}`}: ${file.location ?? ''}`,
        ),
      );
    }
    return [
      el(
        'h2',
        undefined,
        data.result.good ? 'The first bad snapshot after it' : 'The oldest snapshot looked at',
      ),
      el('p', undefined, snapshotText(bad.snapshot)),
      ...badLines(data).map((line) => el('p', undefined, line)),
      ...(bad.files.length > 0 ? [files] : []),
    ];
  }

  function tables(): HTMLElement[] {
    const { good } = data.result;
    if (!good || data.tables.length === 0) return [];
    return [
      el('h2', undefined, 'Tables that changed after it'),
      dataTable(
        ['Table', 'Last change', ''],
        data.tables.map((table) => {
          const actions = el('td');
          actions.append(
            actionButton(
              'Query at Snapshot...',
              () => act('queryAtSnapshot', table.id),
              `Read ${table.schema}.${table.name} at a snapshot you choose, such as @${good.id}`,
            ),
            actionButton(
              'Restore Table to Snapshot...',
              () => act('restoreTable', table.id),
              `Open the script that gives ${table.schema}.${table.name} the rows of a snapshot you choose, such as @${good.id}; nothing runs`,
            ),
          );
          return tableRow([
            el('td', 'name', `${table.schema}.${table.name}`),
            `@${table.lastChange}`,
            actions,
          ]);
        }),
      ),
    ];
  }

  function render(): void {
    const { result } = data;
    const header = pageHeader(context, {
      title: lastGoodHeading(data.scope),
      subtitle: `${healthScopeLabel(data.scope)} · ${data.connection} · newest @${result.newest}`,
      refresh: 'Look for the last good snapshot again',
      actions: [
        ...(result.good
          ? [
              actionButton(
                `Show Catalog at @${result.good.id}`,
                () => act('showCatalog'),
                'Show the catalog in the tree as it was at this snapshot',
              ),
            ]
          : []),
        ...(result.good === null && result.more
          ? [
              actionButton(
                'Look Further',
                () => act('lookFurther'),
                `Look at twice as many snapshots (${result.limit * 2})`,
              ),
            ]
          : []),
      ],
    });
    const main = el('main');
    main.append(
      el('p', 'verdict', verdictText(data)),
      ...(result.good ? [el('p', undefined, snapshotText(result.good))] : []),
      ...badSection(),
      note(filesNote(data)),
      ...tables(),
      note(RESTORE_NOTE),
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
});
