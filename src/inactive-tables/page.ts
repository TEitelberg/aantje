/// <reference lib="dom" />
// Browser side of the Inactive Tables report: the days to read the tables for, and the tables without a change since,
// a page at a time with a filter box, each with the icons of its actions. DOM only; the texts come from model.ts.
import { iconButton } from '../dependencies/icons';
import { isCount, isOptional, isShape, isString } from '../guards';
import { modeGroup, pageHeader, toolbar } from '../shell/blocks';
import { el } from '../shell/dom';
import { approximateCount, count, formatBytes, formatUtc, tableLabel, whoText } from '../shell/model';
import { pagedTable } from '../shell/paged-table';
import type { PagedRow, PagedView } from '../shell/paged-table';
import { reportPage } from '../shell/report-page';
import {
  DAY_CHOICES,
  INACTIVE_COLUMNS,
  MAX_DAYS,
  changeText,
  daysText,
  emptyText,
  fitDays,
  inactiveHeading,
  lastReadText,
  summaryText,
} from './model';
import type { InactiveData, InactiveTable } from './model';
import { isInactiveMessage } from './protocol';
import type { TableActionId } from './protocol';

/** The control that asked for other days: it gets the focus back when their tables arrive. */
type DaysControl = 'choice' | 'field';

type Act = (action: TableActionId, table: number) => void;

/** The filter box, the page and the selected table, kept for a hidden panel, a Refresh and other days. */
interface Saved {
  readonly connection: string;
  /** The days of the list that the page belongs to: the list of other days starts on its first page. */
  readonly days: number;
  readonly text: string;
  readonly page?: number;
  readonly selected?: number;
}

const isSaved = isShape({
  connection: isString,
  days: isCount,
  text: isString,
  page: isOptional(isCount),
  selected: isOptional(isCount),
}) as (value: unknown) => value is Saved;

/** The usual days as buttons and any number in a field; `ask` gets the days the user picked and where. */
function daysControls(
  current: number,
  ask: (days: number, control: DaysControl) => void,
): { readonly bar: HTMLElement; readonly choices: HTMLElement; readonly field: HTMLInputElement } {
  const choices = modeGroup(
    'No change for',
    DAY_CHOICES.map((days) => ({ value: days as number, text: daysText(days) })),
    current,
    (days) => ask(days, 'choice'),
    { shown: true },
  );
  const field = el('input');
  field.type = 'number';
  field.min = '1';
  field.max = String(MAX_DAYS);
  field.value = String(current);
  field.addEventListener('change', () => {
    // An emptied field and a non-numeric one both hold ''; Number('') would be 0.
    const typed = field.value.trim() === '' ? Number.NaN : Number(field.value);
    const days = Number.isInteger(typed) ? fitDays(typed) : current;
    field.value = String(days);
    ask(days, 'field');
  });
  const label = el('label');
  label.append('Days ', field);
  return { bar: toolbar(choices, label), choices, field };
}

/** The actions of a table as icons; each does what the command of that name does on the table. */
function icons(table: InactiveTable, act: Act): HTMLElement {
  const name = tableLabel(table);
  const group = el('span');
  group.append(
    iconButton('tree', 'Show in Tree', `Show in Tree: ${name}`, () => act('revealTable', table.id)),
    iconButton('chart', 'Show Statistics', `Show Statistics: ${name}`, () => act('showStatistics', table.id)),
    iconButton('hierarchy', 'Dependencies', `Dependencies: ${name}`, () => act('showDependencies', table.id)),
  );
  return group;
}

/** A table as a row; the filter box finds it by its name, the author and message of its last change and its comment. */
function rowOf(table: InactiveTable, act: Act): PagedRow<number> {
  const who = whoText(table.change?.author ?? null, table.change?.commitMessage ?? null);
  return {
    key: table.id,
    label: tableLabel(table),
    cells: [
      icons(table, act),
      changeText(table),
      who,
      approximateCount(table.rows, table.approximate === true),
      formatBytes(table.sizeBytes),
      count(table.files),
      table.comment ?? '',
      lastReadText(table),
    ],
    search: [who, table.comment ?? ''].join('\n'),
  };
}

export const inactivePage = reportPage<InactiveData>(
  'inactiveTables',
  isInactiveMessage,
  ({ context, mount }) => {
    let data: InactiveData;
    let asked: { readonly days: number; readonly control: DaysControl } | undefined;
    // Undefined page: the table opens on the page of the selected table, else on the first.
    let view: { readonly text: string; readonly page: number | undefined } = { text: '', page: undefined };
    let selected: number | undefined;

    // The page names an action and a table id, or the days; the extension checks both against its data.
    const act: Act = (action, table) => context.post({ type: 'action', action, ...{ table } });

    const save = (): void =>
      context.state.set({
        connection: data.connection,
        days: data.days,
        text: view.text,
        ...(view.page === undefined ? {} : { page: view.page }),
        ...(selected === undefined ? {} : { selected }),
      });

    function askDays(days: number, control: DaysControl): void {
      if (days === data.days) return;
      asked = { days, control };
      context.post({ type: 'action', action: 'days', ...{ days } });
    }

    function tableList(): HTMLElement[] {
      const table = pagedTable<number>({
        columns: INACTIVE_COLUMNS,
        rows: data.tables.map((entry) => rowOf(entry, act)),
        noun: ['table', 'tables'],
        noMatch: 'No table matches the filter.',
        none: emptyText(data),
        text: view.text,
        page: view.page,
        selected,
        onSelect: (key) => {
          selected = key;
          table.mark(key);
          save();
        },
        onChange: (next: PagedView) => {
          view = next;
          save();
        },
      });
      return data.tables.length === 0 ? [table.table] : [table.controls, table.table];
    }

    function render(): void {
      const header = pageHeader(context, {
        title: inactiveHeading(data.scope),
        subtitle: `${data.connection} · ${summaryText(data)} · @${data.snapshot} · read ${formatUtc(data.readAt)}`,
        refresh: 'Read the tables again; the days stay',
      });
      const controls = daysControls(data.days, askDays);
      const main = el('main');
      main.append(controls.bar, ...tableList());
      mount(header, main);
      // The control that asked for these days gets the focus back, as Refresh does.
      if (asked?.days === data.days) {
        if (asked.control === 'field') {
          controls.field.focus();
        } else {
          (Array.from(controls.choices.children) as HTMLElement[])
            .find((button) => button.getAttribute('aria-pressed') === 'true')
            ?.focus();
        }
      }
      asked = undefined;
    }

    return {
      show(next) {
        const saved = context.state.get();
        const kept = isSaved(saved) && saved.connection === next.connection ? saved : undefined;
        data = next;
        // The box stays; the list of other days starts on its first page, or on the page of the selected table.
        view = { text: kept?.text ?? '', page: kept?.days === next.days ? kept.page : undefined };
        selected =
          kept?.selected !== undefined && next.tables.some(({ id }) => id === kept.selected)
            ? kept.selected
            : undefined;
        render();
        save();
      },
      // Nothing on the page depends on the theme beyond the stylesheet.
      redraw: () => undefined,
    };
  },
);
