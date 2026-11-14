/// <reference lib="dom" />
// The action icons of the Dependencies page: inline SVG in the style of the VS Code codicons. They are drawn in the
// colour of the text, so they follow the theme; there is no icon font.
import { el } from '../shell/dom';

const SVG = 'http://www.w3.org/2000/svg';

export type Icon = 'graph' | 'hierarchy' | 'chart' | 'tree';

type Shape = readonly ['path' | 'circle', Readonly<Record<string, string>>];

// On a grid of 16 by 16 with lines one unit wide; the lines lie on half units, so they stay sharp at 16 pixels.
const SHAPES: Readonly<Record<Icon, readonly Shape[]>> = {
  // Three objects and the arrows between them.
  graph: [
    ['circle', { cx: '3.5', cy: '8', r: '2' }],
    ['circle', { cx: '12.5', cy: '3.5', r: '2' }],
    ['circle', { cx: '12.5', cy: '12.5', r: '2' }],
    ['path', { d: 'M5.3 7.1l5.4-2.7M5.3 8.9l5.4 2.7' }],
  ],
  // A box above two boxes.
  hierarchy: [
    ['path', { d: 'M6.5 1.5h4v4h-4zM8.5 5.5v2M3.5 10.5v-3h10v3M1.5 10.5h4v4h-4zM11.5 10.5h4v4h-4z' }],
  ],
  // Three bars on two axes.
  chart: [
    ['path', { d: 'M1.5 1.5v13h13' }],
    ['path', { d: 'M5 13V8M9 13V4M13 13V6', 'stroke-width': '2' }],
  ],
  // A node and two children below it.
  tree: [['path', { d: 'M1.5 2.5h13M3.5 2.5v10h2M3.5 7.5h2M7.5 7.5h7M7.5 12.5h7' }]],
};

function shapeOf(tag: 'svg' | Shape[0], attributes: Shape[1]): SVGElement {
  const shape = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) {
    shape.setAttribute(name, value);
  }
  return shape;
}

/** A button that shows only an icon: `tip` is its tooltip, `label` what a screen reader hears. */
export function iconButton(icon: Icon, tip: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', 'icon');
  button.title = tip;
  button.setAttribute('aria-label', label);
  const svg = shapeOf('svg', {
    viewBox: '0 0 16 16',
    width: '16',
    height: '16',
    fill: 'none',
    stroke: 'currentColor',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  svg.append(...SHAPES[icon].map(([tag, attributes]) => shapeOf(tag, attributes)));
  button.append(svg);
  button.addEventListener('click', onClick);
  return button;
}
