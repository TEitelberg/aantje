/// <reference lib="dom" />
// The Tips tab of Statistics and Analysis: one row per tip, its kind as an icon first and, where the tip has a script,
// an icon button that asks the extension for it by the place of the tip.
import { el } from '../shell/dom';
import { iconButton, svgIcon } from '../shell/svg-icon';
import type { Shape } from '../shell/svg-icon';
import type { Tip, TipKind } from '../tips/model';
import type { HostPort } from './grid-view';
import type { ResultTab } from './result-tab';

/** The kinds of tips: what each is about, and its icon. */
const KINDS: Readonly<Record<TipKind, { readonly label: string; readonly shapes: readonly Shape[] }>> = {
  // A cloud: the remote storage, and what DuckDB keeps of it.
  cache: {
    label: 'Storage and cache',
    shapes: [['path', { d: 'M4.5 12.5h7a3 3 0 0 0 .3-6 4 4 0 0 0-7.6.9 2.6 2.6 0 0 0 .3 5.1z' }]],
  },
  // A memory chip with its pins.
  spill: {
    label: 'Memory',
    shapes: [
      ['rect', { x: '4.5', y: '4.5', width: '7', height: '7' }],
      ['path', { d: 'M6.5 1.5v3M9.5 1.5v3M6.5 11.5v3M9.5 11.5v3M1.5 6.5h3M1.5 9.5h3M11.5 6.5h3M11.5 9.5h3' }],
    ],
  },
  // Lines that get shorter, and an arrow down: the order of the rows.
  sort: {
    label: 'Table layout',
    shapes: [['path', { d: 'M1.5 3.5h8M1.5 7.5h6M1.5 11.5h4M12.5 2.5v11M10.5 11.5l2 2 2-2' }]],
  },
  // A table of three columns.
  columns: {
    label: 'Columns read',
    shapes: [['path', { d: 'M1.5 2.5h13v11h-13zM5.8 2.5v11M10.2 2.5v11' }]],
  },
  // A wrench.
  maintenance: {
    label: 'Maintenance',
    shapes: [
      [
        'path',
        {
          d: 'M10.5 1.5a3.5 3.5 0 0 0-3.2 4.8l-5.4 5.4a1.4 1.4 0 0 0 2 2l5.4-5.4a3.5 3.5 0 0 0 4.7-4.6l-2 2-1.8-.3-.3-1.8 2-2a3.5 3.5 0 0 0-1.4-.1z',
        },
      ],
    ],
  },
};

// A page with a corner folded and an arrow out of it: open the script in a new document.
const OPEN_SCRIPT: readonly Shape[] = [
  ['path', { d: 'M8.5 14.5h-5v-13h6l3 3v4M9.5 1.5v3h3M10.5 12.5h4M12.5 10.5l2 2-2 2' }],
];

const COLUMNS = ['Tip', 'Details', 'What to do'];

/** The tips of a statement as a table; `set` is the place of their result set, which a script button names. */
export function tipsView(host: HostPort, view: HTMLElement, tips: readonly Tip[], set: number): ResultTab {
  const table = el('table', 'tips');
  const head = el('tr');
  const kindHead = el('th', 'tip-kind');
  kindHead.setAttribute('aria-label', 'Kind');
  const actionHead = el('th', 'tip-action');
  actionHead.setAttribute('aria-label', 'Script');
  head.append(kindHead, ...COLUMNS.map((name) => el('th', undefined, name)), actionHead);
  const thead = el('thead');
  thead.append(head);
  const body = el('tbody');
  for (const [index, tip] of tips.entries()) {
    const { label, shapes } = KINDS[tip.kind];
    const kind = el('td', 'tip-kind');
    kind.title = label;
    const icon = el('span');
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', label);
    icon.append(svgIcon(shapes));
    kind.append(icon);
    const facts = el('td', 'tip-facts');
    facts.append(...tip.facts.map((fact) => el('div', undefined, fact)));
    const action = el('td', 'tip-action');
    if (tip.script !== undefined) {
      action.append(
        iconButton(
          OPEN_SCRIPT,
          'Open script',
          'Open the script of this tip in a new SQL document; it is not run',
          () => host.post({ type: 'openTipScript', set, tip: index }),
        ),
      );
    }
    const row = el('tr');
    row.append(kind, el('td', 'tip-title', tip.title), facts, el('td', 'tip-advice', tip.advice), action);
    body.append(row);
  }
  table.append(thead, body);
  const scroll = el('div', 'tips');
  scroll.tabIndex = 0;
  scroll.append(table);
  view.append(scroll);
  return { elements: [view], placed: () => undefined };
}
