/// <reference lib="dom" />
// The action icons of the Dependencies page (src/shell/svg-icon.ts draws them).
import { iconButton as shownButton } from '../shell/svg-icon';
import type { Shape } from '../shell/svg-icon';

export type Icon = 'graph' | 'hierarchy' | 'chart' | 'tree';

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

/** A button that shows only an icon: `tip` is its tooltip, `label` what a screen reader hears. */
export function iconButton(icon: Icon, tip: string, label: string, onClick: () => void): HTMLButtonElement {
  return shownButton(SHAPES[icon], tip, label, onClick);
}
