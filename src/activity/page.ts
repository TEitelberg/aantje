/// <reference lib="dom" />
// Browser side of the Activity report: state and events; the DOM is built in render.ts.
import { cardGrid, note, pageHeader, tabBar } from '../shell/blocks';
import { el } from '../shell/dom';
import { boundsOf, fitRange } from '../shell/range-state';
import { reportPage } from '../shell/report-page';
import { reportHeading } from '../shell/report-heading';
import { scopeSchema } from '../shell/scope';
import { readTheme } from '../shell/theme';
import { POINT_KINDS } from '../snapshot-changes/model';
import type { Model, PointKind } from '../snapshot-changes/model';
import { windowSubtitle } from '../snapshot-changes/window';
import type { ActivityActionRequest } from './actions';
import type { ActivityMarkdownView } from './markdown';
import { activityCards, activityModelOf, activityOlderNote, summarizeActivity } from './model';
import type { ActivityData } from './model';
import { isActivityMessage } from './protocol';
import { filterBar, headerActions, tabContent } from './render';
import { TABS, restoreActivityChoices, savedActivityState } from './state';
import type { TabId } from './state';

export const activityPage = reportPage<ActivityData>(
  'activity',
  isActivityMessage,
  ({ context, charts, mount }) => {
    let data: ActivityData;
    let model: Model;
    let tab: TabId = 'days';
    let author: string | undefined;
    let table: string | undefined;
    let kinds: ReadonlySet<PointKind> = new Set(POINT_KINDS);
    let text = '';
    let range = { from: 0, to: 0 };
    let showTable: ((key: string | undefined) => void) | undefined;

    const cards = el('div', 'cards-box');
    const tabRow = el('div', 'tab-row');
    const panel = el('section', 'tab-panel');
    panel.setAttribute('role', 'tabpanel');

    const ask = (request: ActivityActionRequest): void => context.post({ type: 'action', ...request });

    // Keeps the choices: VS Code can take down a hidden panel, which then comes back as it was.
    function save(): void {
      context.state.set(
        savedActivityState(data, model, { tab, author, table, kinds: [...kinds], text, range }),
      );
    }

    function pickTable(key: string): void {
      table = key;
      showTable?.(key);
      drawView();
    }

    // Only the tab that is shown has its charts; they are drawn once its panel is in the page, so they take its size.
    function drawView(): void {
      charts.clear();
      const theme = readTheme();
      const summary = summarizeActivity(model, { author, table, kinds: [...kinds], text, range });
      cards.replaceChildren(cardGrid(activityCards(summary, data.snapshots.length), () => ''));
      panel.replaceChildren(...tabContent(tab, { data, summary, theme }, { charts, pickTable }));
      charts.drawAll(theme);
      save();
    }

    function drawTabs(refocus = false): void {
      const bar = tabBar(TABS, tab, (id, focus) => {
        tab = id;
        drawTabs(focus);
        drawView();
      });
      tabRow.replaceChildren(bar);
      if (refocus) {
        (Array.from(bar.children) as HTMLElement[])
          .find((button) => button.getAttribute('aria-selected') === 'true')
          ?.focus();
      }
    }

    function filters(): HTMLElement {
      const bar = filterBar(
        model,
        { author, table, kinds: () => kinds, text, rangeAt: (end) => range[end] },
        {
          onAuthor(key) {
            author = key;
            drawView();
          },
          onTable(key) {
            table = key;
            drawView();
          },
          onText(typed) {
            text = typed;
            drawView();
          },
          onKinds(chosen) {
            kinds = chosen;
            drawView();
          },
          onRange(end, next) {
            range = { ...range, [end]: next };
            drawView();
          },
        },
      );
      showTable = bar.showTable;
      return bar.element;
    }

    return {
      show(next) {
        data = next;
        model = activityModelOf(next);
        const kept = restoreActivityChoices(context.state.get(), next, model);
        tab = kept?.tab ?? 'days';
        author = kept?.author;
        table = kept?.table;
        kinds = new Set(kept?.kinds ?? POINT_KINDS);
        text = kept?.text ?? '';
        range = kept?.range ?? fitRange(undefined, boundsOf(model.snapshots));
        const header = pageHeader(context, {
          title: reportHeading('Activity', scopeSchema(next.scope)),
          subtitle: windowSubtitle(next),
          refresh: 'Read the snapshots again; the choices stay',
          view: (): ActivityMarkdownView => ({ author, table, kinds: [...kinds], text, range }),
          actions: headerActions(ask),
        });
        // The note says what was read, so it comes before the key figures; the tabs follow them directly.
        const notes = el('div', 'notes');
        notes.append(note(activityOlderNote(next)));
        const main = el('main');
        main.append(
          ...(next.snapshots.length > 0 ? [filters()] : []),
          ...(next.more ? [notes] : []),
          cards,
          tabRow,
          panel,
        );
        mount(header, main);
        drawTabs();
        drawView();
      },
      redraw: drawView,
    };
  },
);
