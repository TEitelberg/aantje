/// <reference lib="dom" />
// Browser side of the Activity report: state and events; the DOM is built in render.ts.
import { cardGrid, focusPane, markPicked, note, pageHeader } from '../shell/blocks';
import type { ListRow } from '../shell/blocks';
import { el } from '../shell/dom';
import { boundsOf, fitRange } from '../shell/range-state';
import { reportPage } from '../shell/report-page';
import { scopeSuffix } from '../shell/scope';
import { readTheme } from '../shell/theme';
import { POINT_KINDS } from '../snapshot-changes/model';
import type { Model, PointKind } from '../snapshot-changes/model';
import { windowSubtitle } from '../snapshot-changes/window';
import type { ActivityMarkdownView } from './markdown';
import {
  AUTHOR_EXAMPLE,
  AUTHOR_HINT,
  NO_AUTHOR,
  activityCards,
  activityModelOf,
  activityOlderNote,
  summarizeActivity,
} from './model';
import type { ActivityData } from './model';
import { isActivityMessage } from './protocol';
import { drawAuthors, drawDays, drawDetail, drawList, drawTables, filterBar } from './render';
import { restoreActivityChoices } from './state';

export const activityPage = reportPage<ActivityData>(
  'activity',
  isActivityMessage,
  ({ context, charts, mount }) => {
    let data: ActivityData;
    let model: Model;
    let author: string | undefined;
    let table: string | undefined;
    let kinds: ReadonlySet<PointKind> = new Set(POINT_KINDS);
    let text = '';
    let range = { from: 0, to: 0 };
    let selected: number | undefined;
    let showTable: ((key: string | undefined) => void) | undefined;
    let rows = new Map<number, ListRow>();

    const cards = el('div', 'cards-box');
    const notes = el('div', 'notes');
    const days = el('section', 'days');
    const authors = el('section', 'authors');
    const tables = el('section', 'tables-section');
    const detail = focusPane('detail');
    const list = el('section', 'list');

    const ask = (request: { readonly action: string }): void => context.post({ type: 'action', ...request });

    // Keeps the choices: VS Code can take down a hidden panel, which then comes back as it was.
    function save(): void {
      context.state.set({
        connection: data.connection,
        bounds: boundsOf(model.snapshots),
        author,
        table,
        kinds: [...kinds],
        text,
        range,
        selected,
      });
    }

    function markSelection(): void {
      markPicked(rows, selected);
      drawDetail(detail, { data, model }, selected, ask);
      save();
    }

    function select(id: number): void {
      selected = id;
      markSelection();
    }

    function drawView(): void {
      charts.clear();
      const theme = readTheme();
      const summary = summarizeActivity(model, { author, table, kinds: [...kinds], text, range });
      const view = { data, model, summary, theme };
      cards.replaceChildren(cardGrid(activityCards(summary, data.snapshots.length), () => ''));
      const missing = summary.authors.some((row) => row.author === NO_AUTHOR);
      notes.replaceChildren(
        ...(data.more ? [note(activityOlderNote(data))] : []),
        ...(missing ? [note(`${AUTHOR_HINT} ${AUTHOR_EXAMPLE}`)] : []),
      );
      drawDays(days, view, charts);
      drawAuthors(authors, summary);
      drawTables(tables, view, charts, (key) => {
        table = key;
        showTable?.(key);
        drawView();
      });
      charts.drawAll(theme);
      rows = drawList(list, view, select);
      markSelection();
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
        author = kept?.author;
        table = kept?.table;
        kinds = new Set(kept?.kinds ?? POINT_KINDS);
        text = kept?.text ?? '';
        range = kept?.range ?? fitRange(undefined, boundsOf(model.snapshots));
        selected = kept?.selected;
        const header = pageHeader(context, {
          title: `Activity${scopeSuffix(next.scope)}`,
          subtitle: windowSubtitle(next),
          refresh: 'Read the snapshots again; the choices stay',
          view: (): ActivityMarkdownView => ({ author, table, kinds: [...kinds], text, range }),
        });
        const main = el('main');
        main.append(
          ...(next.snapshots.length > 0 ? [filters()] : []),
          cards,
          notes,
          days,
          authors,
          tables,
          list,
          detail,
        );
        mount(header, main);
        drawView();
      },
      redraw: drawView,
    };
  },
);
