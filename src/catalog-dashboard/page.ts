/// <reference lib="dom" />
// Browser side of the Catalog Dashboard; DOM only, the figures come from model.ts.
import { isCount, isOptional, isShape, isString } from '../guards';
import { actionButton, cardGrid, findingCard, note, pageHeader } from '../shell/blocks';
import { el } from '../shell/dom';
import { formatUtc } from '../shell/model';
import { pagedTable } from '../shell/paged-table';
import type { PagedTable, PagedTableSpec, PagedView } from '../shell/paged-table';
import { reportPage } from '../shell/report-page';
import { readTheme, severityColor } from '../shell/theme';
import {
  DASHBOARD_HEADING,
  ENGINE_LABEL,
  INLINED_COLUMNS,
  dashboardCards,
  dashboardFindings,
  dashboardNotes,
  inlinedTableRows,
  tableColumns,
  tableRows,
} from './model';
import type { DashboardData } from './model';
import { isDashboardMessage } from './protocol';

/** The filter box and the page of each table, and the table selected in them. */
interface Views {
  readonly tables?: PagedView;
  readonly inlined?: PagedView;
  readonly selected?: string;
}

// Kept for a hidden panel and a Refresh of the same connection.
const isView = isShape({ text: isString, page: isCount });
const isSaved = isShape({
  connection: isString,
  tables: isOptional(isView),
  inlined: isOptional(isView),
  selected: isOptional(isString),
}) as (value: unknown) => value is Views & { readonly connection: string };

export const dashboardPage = reportPage<DashboardData>(
  'catalogDashboard',
  isDashboardMessage,
  ({ context, mount }) => {
    let data: DashboardData;
    let views: Views = {};
    // The tables shown, whose rows a selection marks.
    let shown: PagedTable<string>[] = [];

    const act = (action: string, table?: number): void =>
      context.post({ type: 'action', action, ...(table === undefined ? {} : { table }) });

    const save = (): void => context.state.set({ connection: data.connection, ...views });

    // A catalog table is selected in both tables: an inlined data table is listed in each.
    function select(key: string): void {
      views = { ...views, selected: key };
      for (const table of shown) table.mark(key);
      save();
    }

    /** The filter box, the pages and the table; the box and the pages only when there are rows. */
    function paged(
      spec: Pick<PagedTableSpec<string>, 'columns' | 'rows' | 'noun' | 'noMatch' | 'none'>,
      view: PagedView | undefined,
      keep: (view: PagedView) => void,
    ): HTMLElement[] {
      const table = pagedTable<string>({
        ...spec,
        text: view?.text ?? '',
        page: view?.page,
        selected: views.selected,
        onSelect: (key) => select(key),
        onChange: (next) => {
          keep(next);
          save();
        },
      });
      shown.push(table);
      return spec.rows.length === 0 ? [table.table] : [table.controls, table.table];
    }

    function render(): void {
      const theme = readTheme();
      const { database } = data;
      const findings = dashboardFindings(data);
      const inlined = inlinedTableRows(data);
      shown = [];
      const header = pageHeader(context, {
        title: DASHBOARD_HEADING,
        subtitle: `${data.connection} · ${ENGINE_LABEL[database.engine]}${database.version === null ? '' : ` ${database.version}`} · read ${formatUtc(data.readAt)}`,
        refresh: 'Read the statistics of the catalog database again',
        actions: findings.some((finding) => finding.vacuum !== undefined)
          ? [
              actionButton(
                'VACUUM Script',
                () => act('vacuumAll'),
                'Open a VACUUM (ANALYZE) script of every table with many dead rows, for a PostgreSQL client; it is not run',
              ),
            ]
          : [],
      });
      const main = el('main');
      main.append(
        cardGrid(dashboardCards(data), severityColor(theme)),
        ...(findings.length === 0
          ? []
          : [
              el('h2', undefined, 'Findings'),
              ...findings.map((finding) =>
                findingCard({
                  severity: finding.severity === 'info' ? 'ok' : finding.severity,
                  title: finding.title,
                  body: [finding.detail],
                  actions:
                    finding.vacuum === undefined
                      ? []
                      : [
                          actionButton(
                            'Open VACUUM (ANALYZE) Script',
                            () =>
                              act(
                                'vacuumScript',
                                database.tables.findIndex((table) => table.name === finding.vacuum),
                              ),
                            `Open VACUUM (ANALYZE) of ${finding.vacuum} for a PostgreSQL client; it is not run`,
                          ),
                        ],
                }),
              ),
            ]),
        el('h2', undefined, 'Tables'),
        ...paged(
          {
            columns: tableColumns(database),
            rows: tableRows(database),
            noun: ['table', 'tables'],
            noMatch: 'No catalog table matches the filter.',
            none: 'No catalog table was found.',
          },
          views.tables,
          (view) => (views = { ...views, tables: view }),
        ),
        ...(inlined.length === 0
          ? []
          : [
              el('h2', undefined, 'Inlined data'),
              ...paged(
                {
                  columns: INLINED_COLUMNS,
                  rows: inlined,
                  noun: ['inlined table', 'inlined tables'],
                  noMatch: 'No inlined table matches the filter.',
                },
                views.inlined,
                (view) => (views = { ...views, inlined: view }),
              ),
            ]),
        ...dashboardNotes(data).map((line) => note(line)),
      );
      mount(header, main);
    }

    return {
      show(next) {
        data = next;
        const saved = context.state.get();
        const kept = isSaved(saved) && saved.connection === next.connection ? saved : undefined;
        const { selected } = kept ?? {};
        views = {
          ...(kept?.tables ? { tables: kept.tables } : {}),
          ...(kept?.inlined ? { inlined: kept.inlined } : {}),
          ...(selected !== undefined && next.database.tables.some((table) => table.name === selected)
            ? { selected }
            : {}),
        };
        render();
        save();
      },
      redraw: render,
    };
  },
);
