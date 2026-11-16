/// <reference lib="dom" />
// Icons as inline SVG in the style of the VS Code codicons. They are drawn in the colour of the text, so they follow the
// theme; there is no icon font. The pages that show them inline ICON_BUTTON_CSS into their stylesheet.
import { el } from './dom';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * One shape of an icon, on a grid of 16 by 16 with lines one unit wide; the lines lie on half units, so they stay sharp
 * at 16 pixels.
 */
export type Shape = readonly ['path' | 'circle' | 'rect', Readonly<Record<string, string>>];

function shapeOf(tag: 'svg' | Shape[0], attributes: Shape[1]): SVGElement {
  const shape = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) {
    shape.setAttribute(name, value);
  }
  return shape;
}

/** An icon of the shapes, hidden from screen readers: the element around it says what it means. */
export function svgIcon(shapes: readonly Shape[]): SVGElement {
  const svg = shapeOf('svg', {
    viewBox: '0 0 16 16',
    width: '16',
    height: '16',
    fill: 'none',
    stroke: 'currentColor',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  svg.append(...shapes.map(([tag, attributes]) => shapeOf(tag, attributes)));
  return svg;
}

/** A button that shows only an icon: `tip` is its tooltip, `label` what a screen reader hears. */
export function iconButton(
  shapes: readonly Shape[],
  tip: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = el('button', 'icon');
  button.title = tip;
  button.setAttribute('aria-label', label);
  button.append(svgIcon(shapes));
  button.addEventListener('click', onClick);
  return button;
}

/** The look of an icon button, as the buttons of a VS Code toolbar. */
export const ICON_BUTTON_CSS = `button.icon { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: none; border: 1px dashed transparent; border-radius: 5px; cursor: pointer; }
button.icon:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-toolbar-hoverOutline, transparent); }
button.icon:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
button.icon svg { display: block; }`;
