/// <reference lib="dom" />
// The graph of the Dependencies page: draws the picture of the data and reports the objects clicked.
import { empty } from '../shell/blocks';
import { drawChart } from '../shell/charts';
import type { Chart } from '../shell/charts';
import { el } from '../shell/dom';
import { isHighContrast } from '../shell/palette';
import type { Theme } from '../shell/theme';
import { graphHeight, graphOption } from './graph-option';
import type { DependenciesData } from './model';
import { picture } from './picture';
import type { Picture, PictureInput } from './picture';

export interface GraphPane {
  readonly element: HTMLElement;
  /** Draws the graph anew; `centre` is an object to zoom in on. */
  draw(data: DependenciesData, input: PictureInput, theme: Theme, selected?: number, centre?: number): void;
  /** Marks the selected object, and zooms in on it with `centre`; keeps the zoom otherwise. */
  mark(selected: number | undefined, centre?: boolean): void;
  resize(): void;
  /** Takes the chart down, while the list shows. */
  clear(): void;
}

/** `onSelect` gets the object clicked, `onZoom` the object double-clicked; a missing name is no object. */
export function graphPane(
  emptyText: (data: DependenciesData) => string,
  onSelect: (node: number) => void,
  onZoom: (node: number) => void,
): GraphPane {
  const element = el('section', 'graph');
  let chart: Chart | undefined;
  let shown: Picture = { items: [], edges: [] };
  let target: number | null = null;
  let current: Theme | undefined;

  const option = (selected: number | undefined, centre: number | undefined) =>
    current &&
    graphOption(
      { picture: shown, target, selected, centre, contrast: isHighContrast(current.mode) },
      current.palette,
    );
  const nodeAt =
    (then: (node: number) => void) =>
    (index: number): void => {
      const node = shown.items[index]?.node;
      if (node !== undefined) then(node);
    };

  const clear = (): void => {
    chart?.dispose();
    chart = undefined;
  };

  return {
    element,
    draw(data, input, theme, selected, centre) {
      clear();
      current = theme;
      target = data.target;
      shown = picture(data, input);
      if (shown.items.length === 0) {
        element.replaceChildren(empty(emptyText(data)));
        return;
      }
      const box = el('div', 'chart');
      box.style.height = `${graphHeight(shown)}px`;
      element.replaceChildren(box);
      const drawn = option(selected, centre);
      if (drawn) {
        chart = drawChart(box, theme.chart, drawn, undefined, nodeAt(onSelect), nodeAt(onZoom));
      }
    },
    mark(selected, centre = false) {
      const next = option(selected, centre ? selected : undefined);
      if (next) chart?.update(next);
    },
    resize: () => chart?.resize(),
    clear,
  };
}
