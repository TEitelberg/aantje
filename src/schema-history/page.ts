/// <reference lib="dom" />
// Browser side of the Schema History report: state and events; the DOM is built in render.ts.
import { actionButton, pageHeader, tabBar } from '../shell/blocks';
import { el } from '../shell/dom';
import { plural, tableLabel } from '../shell/model';
import { reportHeading } from '../shell/report-heading';
import { reportPage } from '../shell/report-page';
import type { PageShell } from '../shell/report-page';
import { canCompareSchema } from './actions';
import type { SchemaHistoryActionRequest } from './actions';
import type { SchemaHistoryMarkdownView } from './markdown';
import { comparePoints, compareViewOf } from './model';
import type { SchemaHistoryData } from './model';
import { isSchemaHistoryMessage } from './protocol';
import { columnBar, columnHistory, comparison, filters, noteChildren, rangeBar } from './render';
import { TABS, restoreSchemaHistoryChoices, savedSchemaHistoryState } from './state';
import type { SchemaHistoryChoices } from './state';

/** What the page holds between events: the data, the choices, and the blocks it fills again. */
interface Page {
  readonly shell: PageShell;
  readonly data: SchemaHistoryData;
  chosen: SchemaHistoryChoices;
  readonly tabRow: HTMLElement;
  readonly panel: HTMLElement;
}

const ask = (page: Page, request: SchemaHistoryActionRequest): void =>
  page.shell.context.post({ type: 'action', ...request });

// VS Code may take a hidden panel down; the saved choices bring it back as it was.
const save = (page: Page): void =>
  page.shell.context.state.set(savedSchemaHistoryState(page.data, page.chosen));

function choose(page: Page, change: Partial<SchemaHistoryChoices>): void {
  page.chosen = { ...page.chosen, ...change };
  save(page);
}

/** The two snapshots, the filters and the comparison; a change draws the comparison again, not the controls. */
function compareTab(page: Page): HTMLElement[] {
  const { data } = page;
  const points = comparePoints(data);
  const result = el('div', 'result');
  const range = rangeBar(points, page.chosen, {
    onFrom(id) {
      choose(page, { from: id });
      draw();
    },
    onTo(id) {
      choose(page, { to: id });
      draw();
    },
    onCompare: () => ask(page, { action: 'compareSchema', from: page.chosen.from, to: page.chosen.to }),
  });
  function draw(): void {
    const { from, to, kinds, text } = page.chosen;
    range.compare.disabled = !(data.schema !== null && canCompareSchema(data, from, to));
    result.replaceChildren(
      ...comparison(compareViewOf(data, { from, to, kinds, text }), {
        from: points.find(({ id }) => id === from),
        to: points.find(({ id }) => id === to),
      }),
    );
  }
  const bar = filters(
    { kinds: () => new Set(page.chosen.kinds), text: page.chosen.text },
    {
      onKinds(kinds) {
        choose(page, { kinds: [...kinds] });
        draw();
      },
      onText(text) {
        choose(page, { text });
        draw();
      },
    },
  );
  draw();
  return points.length > 0 ? [range.element, bar, result] : [result];
}

/** The column to follow and its changes; the choice draws the list again. */
function searchTab(page: Page): HTMLElement[] {
  const list = el('div', 'result');
  const draw = (): void => list.replaceChildren(columnHistory(page.data, page.chosen.column));
  const bar = columnBar(page.data, page.chosen.column, (column) => {
    choose(page, { column });
    draw();
  });
  draw();
  return [bar, list];
}

function drawTab(page: Page, refocus = false): void {
  const bar = tabBar(TABS, page.chosen.tab, (tab, focus) => {
    choose(page, { tab });
    drawTab(page, focus);
  });
  page.tabRow.replaceChildren(bar);
  page.panel.replaceChildren(...(page.chosen.tab === 'compare' ? compareTab(page) : searchTab(page)));
  if (refocus) {
    (Array.from(bar.children) as HTMLElement[])
      .find((button) => button.getAttribute('aria-selected') === 'true')
      ?.focus();
  }
}

/**
 * Two tabs: Compare, the state of every column at two snapshots and what changed between them; Search Changes, every
 * change of one column. Keeps the tab, the snapshots, the filters and the column when the same table is read again.
 */
export const schemaHistoryPage = reportPage<SchemaHistoryData>(
  'schemaHistory',
  isSchemaHistoryMessage,
  (shell) => {
    const tabRow = el('div', 'tab-row');
    const panel = el('section', 'tab-panel');
    panel.setAttribute('role', 'tabpanel');
    return {
      show(next) {
        const page: Page = {
          shell,
          data: next,
          chosen: restoreSchemaHistoryChoices(shell.context.state.get(), next),
          tabRow,
          panel,
        };
        const header = pageHeader(shell.context, {
          title: reportHeading('Schema History', tableLabel(next)),
          subtitle: `${next.connection} · ${plural(next.snapshots.length, 'snapshot', 'snapshots')} with schema changes, latest @${next.latest}`,
          refresh: 'Read the schema history again; the choices stay',
          view: (): SchemaHistoryMarkdownView => {
            const { from, to, kinds, text, tab, column } = page.chosen;
            return { from, to, kinds, text, ...(tab === 'search' && column !== undefined ? { column } : {}) };
          },
          actions:
            next.exists && next.schema !== null
              ? [
                  actionButton(
                    'Script as ALTER',
                    () => ask(page, { action: 'scriptAlter' }),
                    `Open the ALTER template of ${tableLabel(next)} (its newest state)`,
                  ),
                ]
              : [],
        });
        const notes = el('div', 'notes');
        notes.append(...noteChildren(next));
        const main = el('main');
        main.append(notes, tabRow, panel);
        shell.mount(header, main);
        drawTab(page);
        save(page);
      },
      // Nothing on the page depends on the theme.
      redraw: () => undefined,
    };
  },
);
