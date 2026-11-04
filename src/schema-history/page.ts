/// <reference lib="dom" />
// Browser side of the Schema History report: state and events; the DOM is built in render.ts.
import { pageHeader } from '../shell/blocks';
import { el } from '../shell/dom';
import { plural } from '../shell/model';
import type { Page, PageContext, PageKind } from '../shell/page';
import type { SchemaHistoryActionRequest } from './actions';
import type { SchemaHistoryMarkdownView } from './markdown';
import { CELL_KINDS, LEGEND, schemaHistoryViewOf, tableLabel } from './model';
import type { CellKind, SchemaHistoryData } from './model';
import { isSchemaHistoryMessage } from './protocol';
import { detailChildren, filters, markSelection, matrixContent, noteChildren } from './render';
import type { MatrixParts } from './render';
import { restoreSchemaHistoryChoices } from './state';
import { boundsOf } from '../shell/range-state';

/** Keeps filters, snapshot and column when the same table is read again. */
function createSchemaHistoryPage(context: PageContext): Page<SchemaHistoryData> {
  let data: SchemaHistoryData;
  let kinds = new Set<CellKind>(CELL_KINDS);
  let text = '';
  let range = { from: 0, to: 0 };
  let selected: number | undefined;
  let column: number | undefined;
  let matrixParts: Pick<MatrixParts, 'cells' | 'headings'> = { cells: [], headings: new Map() };

  const notes = el('div', 'notes');
  const matrix = el('div', 'matrix');
  const detail = el('section', 'detail');
  // The pane is replaced when the selection changes; it takes the focus that the button in it loses.
  detail.tabIndex = -1;

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
      range = kept?.range ?? { from: next.snapshots[0]?.id ?? 0, to: next.snapshots.at(-1)?.id ?? 0 };
      selected = kept?.selected;
      column = kept?.column;
      const header = pageHeader(context, {
        title: `${tableLabel(next)} schema history`,
        subtitle: `${next.connection} · ${plural(next.snapshots.length, 'snapshot', 'snapshots')} with schema changes, latest @${next.latest}`,
        refresh: 'Read the schema history again; the choices stay',
        view: (): SchemaHistoryMarkdownView => ({ kinds: [...kinds], text, range }),
      });
      const bar = filters(
        { data: next, kinds, text, range: () => range },
        {
          onKinds: redrawAndSave,
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
      context.app.replaceChildren(header.element, main);
      drawMatrix();
      drawDetail();
      header.settle();
    },
    redraw() {},
    resize() {},
  };
}

export const schemaHistoryPage: PageKind<SchemaHistoryData> = {
  type: 'schemaHistory',
  isMessage: isSchemaHistoryMessage,
  create: createSchemaHistoryPage,
};
