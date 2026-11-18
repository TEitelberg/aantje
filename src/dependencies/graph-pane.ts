/// <reference lib="dom" />
// The graph of the Dependencies page: draws the picture of the data and reports the objects clicked. In the column mode
// each object is a box of its columns, with lines between the columns.
import { empty } from '../shell/blocks';
import { drawChart } from '../shell/charts';
import type { Chart } from '../shell/charts';
import { el } from '../shell/dom';
import { isHighContrast } from '../shell/palette';
import type { Theme } from '../shell/theme';
import { columnGraphHeight, columnGraphOption } from './column-graph-option';
import { columnPicture } from './column-picture';
import type { ColumnPicture } from './column-picture';
import { graphHeight, graphOption } from './graph-option';
import type { ChartSize } from './graph-option';
import type { DependenciesData } from './model';
import { picture } from './picture';
import type { GraphMode, GraphReach, Picture } from './picture';

/** What a graph shows: what the graph of an object holds, and the objects or their columns. */
export interface GraphInput {
  readonly reach: GraphReach;
  readonly mode: GraphMode;
}

export interface GraphPane {
  readonly element: HTMLElement;
  /** Draws the graph anew around the selected object; `frame` zooms to fit what is not faint. */
  draw(
    data: DependenciesData,
    input: GraphInput,
    theme: Theme,
    selected: number | undefined,
    frame?: boolean,
  ): void;
  /**
   * Marks the selected object; in the graph of the lake or a schema, what is not connected to it fades. `frame` zooms to
   * fit what is not faint; the zoom stays otherwise.
   */
  mark(selected: number | undefined, frame?: boolean): void;
  resize(): void;
  /** Takes the chart down, while another tab shows. */
  clear(): void;
}

type Shown =
  | { readonly mode: 'objects'; readonly picture: Picture }
  | { readonly mode: 'columns'; readonly picture: ColumnPicture };

const shownOf = (data: DependenciesData, input: GraphInput, selected: number | undefined): Shown =>
  input.mode === 'columns' && data.lineage
    ? { mode: 'columns', picture: columnPicture(data, { reach: input.reach }) }
    : { mode: 'objects', picture: picture(data, { reach: input.reach, focus: selected }) };

/** `onSelect` gets the object clicked, `onZoom` the object double-clicked; a missing name is no object. */
export function graphPane(
  emptyText: (data: DependenciesData) => string,
  onSelect: (node: number) => void,
  onZoom: (node: number) => void,
): GraphPane {
  const element = el('section', 'graph');
  let chart: Chart | undefined;
  let box: HTMLElement | undefined;
  let drawn:
    { readonly data: DependenciesData; readonly input: GraphInput; readonly theme: Theme } | undefined;
  let shown: Shown = { mode: 'objects', picture: { items: [], edges: [] } };

  // The size of the chart, which a frame fits; the box is in the page when the chart is drawn or updated.
  const size = (): ChartSize | undefined =>
    box && box.clientWidth > 0 && box.clientHeight > 0
      ? { width: box.clientWidth, height: box.clientHeight }
      : undefined;
  const option = (selected: number | undefined, frame: boolean) => {
    if (!drawn) return undefined;
    const { data, theme } = drawn;
    const common = { target: data.target, selected, frame, size: frame ? size() : undefined };
    return shown.mode === 'objects'
      ? graphOption(
          { ...common, picture: shown.picture, contrast: isHighContrast(theme.mode) },
          theme.palette,
        )
      : columnGraphOption({ ...common, picture: shown.picture }, theme.palette);
  };
  const nodeAt =
    (then: (node: number) => void) =>
    (index: number): void => {
      const node = shown.picture.items[index]?.node;
      if (node !== undefined) then(node);
    };

  const clear = (): void => {
    chart?.dispose();
    chart = undefined;
    box = undefined;
  };

  return {
    element,
    draw(data, input, theme, selected, frame = false) {
      clear();
      drawn = { data, input, theme };
      shown = shownOf(data, input, selected);
      if (shown.picture.items.length === 0) {
        element.replaceChildren(empty(emptyText(data)));
        return;
      }
      const chartBox = el('div', 'chart');
      const height = shown.mode === 'objects' ? graphHeight(shown.picture) : columnGraphHeight(shown.picture);
      chartBox.style.height = `${height}px`;
      element.replaceChildren(chartBox);
      box = chartBox;
      const next = option(selected, frame);
      if (next) {
        chart = drawChart(chartBox, theme.chart, next, undefined, nodeAt(onSelect), nodeAt(onZoom));
      }
    },
    mark(selected, frame = false) {
      if (!drawn || !chart) return;
      // The places stay; what is faint follows the selection in the graph of the lake or a schema.
      shown = shownOf(drawn.data, drawn.input, selected);
      const next = option(selected, frame);
      if (next) chart.update(next);
    },
    resize: () => chart?.resize(),
    clear,
  };
}
