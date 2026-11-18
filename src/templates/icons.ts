// The icons of the actions on a template, for the icon buttons of the lists of Browse and Recently created
// (src/shell/svg-icon.ts draws them, in the style of the codicons).
import type { Shape } from '../shell/svg-icon';
import type { TemplateActionId } from './protocol';

/** The actions on one template; `copy` is Duplicate. */
export type TemplateItemAction = Exclude<TemplateActionId, 'import' | 'example'>;

export const TEMPLATE_ICONS: Readonly<Record<TemplateItemAction, readonly Shape[]>> = {
  // A triangle pointing right: start from the template.
  use: [['path', { d: 'M4.5 2.5v11l9-5.5z' }]],
  // A pencil, its tip at the lower left.
  edit: [['path', { d: 'M2.5 13.5l1-3.5 7.5-7.5 2.5 2.5-7.5 7.5zM9.5 4l2.5 2.5M3.5 10l2.5 2.5' }]],
  // An arrow up out of a tray.
  export: [['path', { d: 'M2.5 9.5v4h12v-4M8.5 10.5v-9M5.5 4.5l3-3 3 3' }]],
  // A bin with its lid and handle.
  delete: [['path', { d: 'M2.5 3.5h11M6.5 3.5v-2h3v2M3.5 3.5l1 10h7l1-10M6.5 6.5v4M9.5 6.5v4' }]],
  // Two sheets, one in front of the other.
  copy: [
    ['path', { d: 'M5.5 10.5h-3v-9h8v4' }],
    ['rect', { x: '5.5', y: '5.5', width: '8', height: '9' }],
  ],
};
