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
  truncation,
} from '../shell/blocks';
import { el } from '../shell/dom';
import { count } from '../shell/model';
import { reportPage } from '../shell/report-page';
import { METADATA_ROWS, matchingMetadata, propertiesCards, scopeText } from './model';
import type { PropertiesData, PropertiesView } from './model';
import { isPropertiesMessage } from './protocol';
import { restoredFilter, savedState } from './state';

const ACTION_LABEL = { showStorage: 'Show Storage Report' } as const;

export const propertiesPage = reportPage<PropertiesData>(
  'properties',
  isPropertiesMessage,
  ({ context, mount }) => {
    let data: PropertiesData;
    let filter = '';
    const table = el('div', 'metadata');

    function drawTable(): void {
      const matching = matchingMetadata(data.properties.metadata, filter);
      const shown = matching.slice(0, METADATA_ROWS);
      table.replaceChildren(
        matching.length === 0
          ? empty(
              data.properties.metadata.length === 0
                ? 'This catalog has no metadata entries.'
                : `No metadata entry matches "${filter.trim()}".`,
            )
          : dataTable(
              ['Key', 'Value', 'Scope'],
              shown.map((entry) =>
                tableRow([el('td', 'name', entry.key), el('td', 'value', entry.value), scopeText(entry)]),
              ),
            ),
        ...(matching.length > shown.length
          ? [
              truncation(
                shown.length,
                matching.length,
                'entries',
                'Type in the filter box to find the others.',
              ),
            ]
          : []),
      );
    }

    function save(): void {
      context.state.set(savedState(data, filter));
    }

    return {
      show(next) {
        data = next;
        filter = restoredFilter(context.state.get(), next);
        const { properties } = next;
        const header = pageHeader(context, {
          title: 'Properties',
          subtitle: `${next.connection} · ${count(properties.metadata.length)} metadata entries`,
          refresh: 'Read the properties again; the filter stays',
          view: (): PropertiesView => ({ filter }),
        });
        const main = el('main');
        main.append(
          cardGrid(propertiesCards(properties), () => ''),
          el('h2', undefined, 'Metadata'),
          toolbar(
            searchBox('Filter', filter, (text) => {
              filter = text;
              drawTable();
              save();
            }),
            ...next.actions.map((action) =>
              actionButton(ACTION_LABEL[action], () => context.post({ type: 'action', action })),
            ),
          ),
          table,
        );
        mount(header, main);
        drawTable();
      },
      // Nothing on the page depends on the theme.
      redraw: () => undefined,
    };
  },
);
