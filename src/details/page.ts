/// <reference lib="dom" />
// Browser side of the Details report: state and events; the DOM is built in render.ts.
import { actionButton, kindBoxes, note, pageHeader, searchBox, tabBar, toolbar } from '../shell/blocks';
import { el } from '../shell/dom';
import { formatUtc } from '../shell/model';
import { reportPage } from '../shell/report-page';
import { reportHeading } from '../shell/report-heading';
import { scopeSchema } from '../shell/scope';
import { DEFAULT_VIEW, OBJECT_COLUMNS, TABS, detailsNotes } from './model';
import type { DetailsData, DetailsView, TabId } from './model';
import { isDetailsMessage } from './protocol';
import type { DetailsAction } from './protocol';
import { listChildren, rowKind } from './render';
import { restoredChoices, savedState } from './state';

const COLUMN_KEYS = OBJECT_COLUMNS.map(({ key }) => key);
const COLUMN_LABELS = Object.fromEntries(OBJECT_COLUMNS.map(({ key, label }) => [key, label]));

export const detailsPage = reportPage<DetailsData>('details', isDetailsMessage, ({ context, mount }) => {
  let data: DetailsData;
  let view: DetailsView = DEFAULT_VIEW;
  let selected: string | undefined;
  const listBox = el('div', 'list');

  const post = (message: DetailsAction): void => context.post(message);
  const change = (next: Partial<DetailsView>): void => {
    view = { ...view, ...next };
    context.state.set(savedState(data, { view, selected }));
  };

  function drawList(focus?: { readonly row?: string; readonly heading?: string }): void {
    const drawn = listChildren(data, view, selected, {
      onSort: (sort) => {
        change({ sort });
        drawList({ heading: sort.key });
      },
      onPick: (key) => {
        selected = key;
        change({});
        drawList({ row: key });
      },
      act: (action, row) => post({ type: 'action', action, kind: rowKind(row), id: row.id }),
    });
    listBox.replaceChildren(...drawn.children);
    if (focus?.row !== undefined) drawn.picks.get(focus.row)?.focus();
    if (focus?.heading !== undefined) drawn.headings.get(focus.heading)?.focus();
  }

  function columnChoice(): HTMLElement {
    const choices = el('details', 'columns');
    choices.open = view.columns.length !== DEFAULT_VIEW.columns.length;
    choices.append(
      el('summary', undefined, 'Columns'),
      kindBoxes(
        COLUMN_KEYS,
        COLUMN_LABELS,
        () => new Set(view.columns),
        (next) => {
          change({ columns: COLUMN_KEYS.filter((key) => next.has(key)) });
          drawList();
        },
      ),
    );
    return choices;
  }

  function render(refocusTab = false): void {
    const header = pageHeader(context, {
      title: reportHeading('Details', scopeSchema(data.scope)),
      subtitle: `Snapshot @${data.snapshot} · ${data.connection} · read ${formatUtc(data.readAt)}`,
      refresh: 'Read the details again at the snapshot that the tree shows',
      view: (): DetailsView => view,
      actions: [
        actionButton(
          'Copy',
          () => post({ type: 'action', action: 'copy', view }),
          'Copy the list as it is shown, tab separated, for a spreadsheet',
        ),
      ],
    });
    const tabs = tabBar(TABS, view.tab, (id: TabId, refocus) => {
      change({ tab: id });
      render(refocus);
    });
    const main = el('main');
    main.setAttribute('role', 'tabpanel');
    main.append(
      toolbar(
        searchBox('Filter', view.filter, (text) => {
          change({ filter: text });
          drawList();
        }),
      ),
      ...(view.tab === 'objects' ? [columnChoice()] : []),
      listBox,
      ...detailsNotes(data).map((text) => note(text)),
    );
    drawList();
    mount(header, tabs, main);
    if (refocusTab) {
      (Array.from(tabs.children) as HTMLElement[])
        .find((button) => button.getAttribute('aria-selected') === 'true')
        ?.focus();
    }
  }

  return {
    show(next) {
      data = next;
      ({ view, selected } = restoredChoices(context.state.get(), next));
      render();
    },
    redraw: () => render(),
  };
});
