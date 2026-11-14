/// <reference lib="dom" />
// Browser side of the Schema History report: state and events; the DOM is built in render.ts.
import { focusPane, pageHeader } from '../shell/blocks';
import { el } from '../shell/dom';
import { plural, tableLabel } from '../shell/model';
import { boundsOf, fitRange } from '../shell/range-state';
import { reportPage } from '../shell/report-page';
import type { SchemaHistoryActionRequest } from './actions';
import type { SchemaHistoryMarkdownView } from './markdown';
import { CELL_KINDS, LEGEND, schemaHistoryViewOf } from './model';
import type { CellKind, SchemaHistoryData } from './model';
import { isSchemaHistoryMessage } from './protocol';
import { detailChildren, filters, markSelection, matrixContent, noteChildren } from './render';
import type { MatrixParts } from './render';
import { restoreSchemaHistoryChoices } from './state';

/** Keeps filters, snapshot and column when the same table is read again. */
export const schemaHistoryPage = reportPage<SchemaHistoryData>(
  'schemaHistory',
  isSchemaHistoryMessage,
  ({ context, mount }) => {
    let data: SchemaHistoryData;
    let kinds: ReadonlySet<CellKind> = new Set(CELL_KINDS);
    let text = '';
    let range = { from: 0, to: 0 };
    let selected: number | undefined;
    let column: number | undefined;
    let matrixParts: Pick<MatrixParts, 'cells' | 'headings'> = { cells: [], headings: new Map() };

    const notes = el('div', 'notes');
    const matrix = el('div', 'matrix');
    const detail = focusPane('detail');

    const ask = (request: SchemaHistoryActionRequest): void => context.post({ type: 'action', ...request });

    function save(): void {
      context.state.set({
        connection: data.connection,
        tableId: data.tableId,
        bounds: boundsOf(data.snapshots),
        kinds: [...kinds],
        text,
        range,
        selected,
        column,
      });
    }

    const drawDetail = (): void => detail.replaceChildren(...detailChildren(data, selected, column, ask));

    function select(id: number, columnId: number | undefined): void {
      selected = id;
      column = columnId;
      markSelection(matrixParts, selected, column);
      drawDetail();
      save();
    }

    function drawMatrix(): void {
      const view = schemaHistoryViewOf(data, { kinds: [...kinds], text, range });
      notes.replaceChildren(...noteChildren(data, view));
      const drawn = matrixContent(data, view, select);
      matrixParts = drawn;
      matrix.replaceChildren(drawn.element);
      markSelection(matrixParts, selected, column);
    }

    const redrawAndSave = (): void => {
      drawMatrix();
      save();
    };

    return {
      show(next) {
        data = next;
        const kept = restoreSchemaHistoryChoices(context.state.get(), next);
        kinds = new Set(kept?.kinds ?? CELL_KINDS);
        text = kept?.text ?? '';
        range = kept?.range ?? fitRange(undefined, boundsOf(next.snapshots));
        selected = kept?.selected;
        column = kept?.column;
        const header = pageHeader(context, {
          title: `${tableLabel(next)} schema history`,
          subtitle: `${next.connection} · ${plural(next.snapshots.length, 'snapshot', 'snapshots')} with schema changes, latest @${next.latest}`,
          refresh: 'Read the schema history again; the choices stay',
          view: (): SchemaHistoryMarkdownView => ({ kinds: [...kinds], text, range }),
        });
        const bar = filters(
          { data: next, kinds: () => kinds, text, range: () => range },
          {
            onKinds(chosen) {
              kinds = chosen;
              redrawAndSave();
            },
            onText(typed) {
              text = typed;
              redrawAndSave();
            },
            onRange(end, value) {
              range = { ...range, [end]: value };
              redrawAndSave();
            },
          },
        );
        const main = el('main');
        main.append(
          ...(next.snapshots.length > 0 ? [bar] : []),
          notes,
          el('p', 'note legend', LEGEND),
          matrix,
          detail,
        );
        mount(header, main);
        drawMatrix();
        drawDetail();
      },
      // Nothing on the page depends on the theme.
      redraw: () => undefined,
    };
  },
);
